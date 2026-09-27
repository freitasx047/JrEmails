'use strict';

/**
 * API do JR Emails — função única, igual em espírito ao server.js original
 * (sessão em memória por X-Session-Id), só que rodando na Vercel.
 *
 * Nota sobre memória em serverless: isto funciona bem numa instância
 * "quente" (mesma execução reaproveitada entre requests, que é o caso mais
 * comum em uso normal), mas a Vercel pode subir uma instância nova a
 * qualquer momento (cold start, escala, deploy) e nesse caso a sessão se
 * perde e o app pede pra gerar o e-mail de novo — é a limitação inerente de
 * guardar estado em memória fora de um processo único sempre ligado.
 */

const crypto = require('node:crypto');

const BASE_URL = 'https://tempmailbee.com';
const SESSION_TTL_MS = 60 * 60 * 1000; // 1h de inatividade
const UPSTREAM_TIMEOUT_MS = 15_000;

// `global` sobrevive entre invocações na mesma instância (mas não entre
// instâncias diferentes) — é o mais perto que serverless chega de uma
// variável de módulo persistente.
const sessions = global.__jrEmailSessions || (global.__jrEmailSessions = new Map());

function getOrCreateSession(req) {
  let sid = req.headers['x-session-id'];
  if (Array.isArray(sid)) sid = sid[0];
  if (!sid || typeof sid !== 'string') sid = crypto.randomUUID();

  let session = sessions.get(sid);
  if (!session) {
    session = { accessToken: null, cookieJar: new Map(), email: null, expiresAt: null, lastSeen: Date.now() };
    sessions.set(sid, session);
  }
  session.lastSeen = Date.now();
  session.sid = sid;

  // limpeza oportunista de sessões velhas
  const now = Date.now();
  for (const [k, s] of sessions) {
    if (now - s.lastSeen > SESSION_TTL_MS) sessions.delete(k);
  }
  return session;
}

function updateCookieJar(session, res) {
  const setCookies =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : res.headers.get('set-cookie')
        ? [res.headers.get('set-cookie')]
        : [];
  for (const cookieStr of setCookies) {
    const pair = cookieStr.split(';')[0];
    const idx = pair.indexOf('=');
    if (idx > -1) session.cookieJar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

function cookieHeader(session) {
  return Array.from(session.cookieJar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

// Headers de navegador de verdade — muitos provedores de temp-mail usam
// Cloudflare/anti-bot e bloqueiam requisições sem Origin/Referer/UA
// plausíveis. Isso é o principal candidato a corrigir o 502 de autenticação.
function authHeaders(session) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Origin: BASE_URL,
    Referer: `${BASE_URL}/`,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  };
  if (session.accessToken) headers.Authorization = `Bearer ${session.accessToken}`;
  const cookies = cookieHeader(session);
  if (cookies) headers.Cookie = cookies;
  return headers;
}

async function upstreamFetch(session, url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    updateCookieJar(session, res);
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

// Lê o corpo como texto primeiro (em vez de .json() direto) pra conseguir
// logar a resposta crua quando o provedor devolver algo inesperado (ex.:
// uma página HTML de desafio anti-bot em vez de JSON).
async function readUpstreamJson(res, label) {
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* não era JSON — provavelmente bloqueio/erro do provedor */
  }
  if (!res.ok || !data) {
    console.error(`[upstream:${label}] status=${res.status} body=${text.slice(0, 500)}`);
  }
  return { ok: res.ok, status: res.status, data };
}

async function ensureToken(session) {
  if (session.accessToken) return session.accessToken;
  const res = await upstreamFetch(session, `${BASE_URL}/api/auth/anonymous/`, {
    method: 'POST',
    headers: authHeaders(session),
  });
  const { ok, status, data } = await readUpstreamJson(res, 'auth');
  if (!ok || !data || !data.success || !data.access_token) {
    throw new Error(`Falha ao obter token anônimo (status ${status}). Veja os logs da função na Vercel para o corpo da resposta do provedor.`);
  }
  session.accessToken = data.access_token;
  return session.accessToken;
}

async function listDomains(session) {
  await ensureToken(session);
  const res = await upstreamFetch(session, `${BASE_URL}/api/domains/`, { headers: authHeaders(session) });
  const { ok, status, data } = await readUpstreamJson(res, 'domains');
  if (!ok || !data) throw new Error(`Falha ao listar domínios (status ${status}).`);
  return data.available_domains || [];
}

async function createMailbox(session, { username, domain } = {}) {
  await ensureToken(session);
  const params = new URLSearchParams();

  if (username) {
    let finalDomain = domain;
    if (!finalDomain) {
      const domains = await listDomains(session);
      if (!domains.length) throw new Error('Nenhum domínio disponível');
      finalDomain = domains[0];
    }
    params.set('email_address', `${username}@${finalDomain}`);
    params.set('free_domain', 'false');
  } else {
    params.set('free_domain', 'true');
  }

  const res = await upstreamFetch(session, `${BASE_URL}/api/mailbox/create/?${params.toString()}`, {
    method: 'POST',
    headers: authHeaders(session),
  });
  const { ok, status, data } = await readUpstreamJson(res, 'create');
  if (!ok || !data) throw new Error(`Erro HTTP ${status} ao criar e-mail`);

  session.email = data.email_address;
  session.expiresAt = data.expires_at;
  return data;
}

async function getEmails(session) {
  if (!session.email) throw new Error('Nenhuma caixa de e-mail ativa nesta sessão');
  const url = `${BASE_URL}/api/mailbox/emails/?email_address=${encodeURIComponent(session.email)}`;
  const res = await upstreamFetch(session, url, { headers: authHeaders(session) });
  const { ok, status, data } = await readUpstreamJson(res, 'emails');
  if (!ok || !data) throw new Error(`Erro HTTP ${status} ao buscar e-mails`);
  return data;
}

async function deleteMailbox(session) {
  if (!session.email) return true;
  const url = `${BASE_URL}/api/mailbox/delete/?email_address=${encodeURIComponent(session.email)}`;
  const res = await upstreamFetch(session, url, { method: 'DELETE', headers: authHeaders(session) });
  session.email = null;
  session.expiresAt = null;
  return res.ok;
}

function setCors(req, res) {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Id');
}

function sendJson(res, status, payload) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(status).json(payload);
}

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname.replace(/^\/api\/?/, ''); // "domains" | "mailbox" | "emails"
  const session = getOrCreateSession(req);

  try {
    if (pathname === 'domains' && req.method === 'GET') {
      const domains = await listDomains(session);
      return sendJson(res, 200, { success: true, domains, sid: session.sid });
    }

    if (pathname === 'mailbox' && req.method === 'POST') {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const mailbox = await createMailbox(session, {
        username: typeof body.username === 'string' ? body.username.trim() || undefined : undefined,
        domain: typeof body.domain === 'string' ? body.domain.trim() || undefined : undefined,
      });
      return sendJson(res, 200, { success: true, mailbox, sid: session.sid });
    }

    if (pathname === 'mailbox' && req.method === 'GET') {
      return sendJson(res, 200, {
        success: true,
        email: session.email,
        expires_at: session.expiresAt,
        sid: session.sid,
      });
    }

    if (pathname === 'mailbox' && req.method === 'DELETE') {
      const ok = await deleteMailbox(session);
      return sendJson(res, 200, { success: ok });
    }

    if (pathname === 'emails' && req.method === 'GET') {
      const data = await getEmails(session);
      return sendJson(res, 200, data);
    }

    return sendJson(res, 404, { success: false, error: 'Rota não encontrada' });
  } catch (err) {
    console.error('[api]', pathname, err);
    return sendJson(res, 500, { success: false, error: err.message || 'Erro interno' });
  }
};
