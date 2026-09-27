# JR Emails — pronto para a Vercel

Cliente de e-mail temporário (frontend estático + 1 função serverless) que
fala com a API do TempMailBee.

## O que mudou em relação ao `server.js` original

Bem pouco, de propósito. A única mudança realmente necessária pra rodar na
Vercel é que `server.js` (um processo Node sempre ligado, ouvindo uma
porta) virou `api/[...path].js` (uma função serverless que atende
`/api/domains`, `/api/mailbox` e `/api/emails`). A lógica de sessão por
`X-Session-Id`, o front-end e o resto do comportamento são os mesmos.

Isso quer dizer: dentro de uma mesma instância "quente" da função, a
sessão fica em memória igual antes. A diferença é que a Vercel pode subir
uma instância nova de vez em quando (cold start, deploy, escala) — aí a
sessão daquele visitante some e o app simplesmente pede pra gerar o e-mail
de novo. Pra uso normal isso raramente é perceptível.

## Sobre o erro 502 "Falha ao autenticar com o provedor"

Esse erro sai quando a própria chamada da função para
`tempmailbee.com/api/auth/anonymous/` falha ou volta algo que não é o JSON
esperado — **isso acontece nessa chamada em si, não tem relação com a
arquitetura de sessão** (o `server.js` original teria o mesmo problema se
rodasse num ambiente onde essa chamada falhasse). As duas coisas que essa
versão já mudou pra reduzir a chance disso:

1. A função agora manda headers de navegador de verdade (`Origin`,
   `Referer`, `Accept`, `User-Agent` de Chrome) — muitos provedores de
   temp-mail usam Cloudflare/anti-bot e bloqueiam chamadas server-to-server
   sem esses headers.
2. Quando a resposta do provedor não é o JSON esperado (por exemplo, uma
   página de desafio em HTML), a função agora **loga o status e o corpo
   da resposta** nos logs da Vercel, em vez de só devolver um erro genérico.

**Se o erro persistir**, veja o log real:

```bash
vercel logs <seu-deploy-url> --follow
```

ou pelo painel: Project → Deployments → (deploy) → Functions →
`api/[...path]` → Logs. Vai aparecer uma linha tipo:

```
[upstream:auth] status=403 body=<html>...cloudflare...
```

Isso confirma bloqueio anti-bot (nesse caso a solução exigiria contornar o
desafio da Cloudflare, o que muda a complexidade do projeto). Se o status
for outro (404, 401, formato de resposta diferente), me manda essa linha
do log que eu ajusto o ponto certo em `api/[...path].js`.

## Deploy na Vercel

```bash
npm i -g vercel
vercel          # preview
vercel --prod   # produção
```

Ou pelo painel: "Add New Project" → importar esta pasta → Deploy (zero
configuração de build).

## Rodando localmente

```bash
npm i -g vercel
vercel dev
```

## Proteções que ficaram (passivas, não afetam a API)

`vercel.json` define headers de segurança na resposta (CSP, HSTS,
`X-Frame-Options`, etc.) — isso é só metadado de resposta HTTP, não muda em
nada a chamada que a função faz pro TempMailBee. Se quiser tirar mesmo
assim, é só apagar o arquivo `vercel.json`.

## Observação

Este projeto depende da API do TempMailBee, que não é documentada
publicamente — foi identificada por engenharia reversa do site original.
Vale confirmar que você tem respaldo pra reativar isso publicamente antes
de divulgar o link.
