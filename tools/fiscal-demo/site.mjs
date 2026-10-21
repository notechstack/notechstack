// Site da demonstração (:3000): serve a raiz do repositório como a Vercel com `trailingSlash: true` (308 para a
// pasta com barra, pasta/ → pasta/index.html, "/" → a home do vercel.json), faz proxy de /agentes/fiscal/api/* →
// API do app (:3001/api/*, sem a barra final, como o rewrite do vercel.json) e de /functions/v1/* e /auth/v1/* →
// Supabase local, tudo na mesma origem. Serve um config.js local no lugar do de produção e troca o link wa.me da
// ativação pelo dublê da Meta. Painel e gerador de A1 de teste em /__demo/.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gerarA1, SENHA_A1_DEMO } from './a1.mjs';
import { esc, pagina } from './http.mjs';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.mp4': 'video/mp4', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml'
};

async function lerCorpo(req) { const p = []; for await (const c of req) p.push(c); return Buffer.concat(p); }

async function proxy(req, res, alvo, { trocarResposta } = {}) {
  const corpo = await lerCorpo(req);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!/^(host|connection|content-length|accept-encoding|origin|referer)$/i.test(k)) headers[k] = v;
  let r;
  try {
    r = await fetch(alvo, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' || !corpo.length ? undefined : corpo, redirect: 'manual' });
  } catch {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error_code: 'DEMO_SEM_SERVICO', mensagem: `A demonstração não alcançou ${new URL(alvo).host}.` }));
    return;
  }
  let saida = Buffer.from(await r.arrayBuffer());
  if (trocarResposta && r.ok) saida = Buffer.from(trocarResposta(saida.toString('utf8')));
  const cabecalhos = {};
  r.headers.forEach((v, k) => { if (!/^(content-length|content-encoding|transfer-encoding|connection|access-control-.*)$/i.test(k)) cabecalhos[k] = v; });
  res.writeHead(r.status, cabecalhos);
  res.end(saida);
}

// O link do WhatsApp da ativação vai para a conversa do dublê da Meta (Landing do lote E).
export function trocarWaMe(texto, metaUrl) {
  try {
    const j = JSON.parse(texto);
    if (j && typeof j.whatsapp_url === 'string') {
      const u = new URL(j.whatsapp_url);
      if (u.hostname === 'wa.me') j.whatsapp_url = `${metaUrl}/conversa?numero=${encodeURIComponent(u.pathname.replace(/\D/g, ''))}&text=${encodeURIComponent(u.searchParams.get('text') || '')}`;
    }
    return JSON.stringify(j);
  } catch { return texto; }
}

function painel(urls) {
  return pagina('Painel', `<h1>Demonstração do nó.fiscal</h1><p class="cinza">Tudo roda nesta máquina: site, API do app, edge functions no Supabase local e os dublês. Nada sai para a Sefin, a Meta, a Resend, o Pagar.me ou a Anthropic.</p>
<div class="cartao"><ol>
<li><a href="/agentes/fiscal/">LP do agente fiscal</a> → <a href="/agentes/fiscal/comecar/?plano=pro">Começar (Pro)</a> · <a href="/agentes/fiscal/comecar/?plano=inicial">Começar (Inicial)</a> · <a href="/agentes/fiscal/conta/">Minha conta</a></li>
<li>Código do e-mail: <a href="${esc(urls.resend)}" target="_blank">caixa de entrada (${esc(urls.resend)})</a></li>
<li>Cartão aprovado <code>4111 1111 1111 1111</code>, recusado <code>4000 0000 0000 0010</code>, validade futura, CVV qualquer · <a href="${esc(urls.pagarme)}" target="_blank">Pagar.me</a></li>
<li>CNPJ: qualquer um com dígitos válidos (ex.: <code>11.222.333/0001-81</code>); começando com 00000000 não existe; com 99, município fora do padrão</li>
<li>WhatsApp do agente: <a href="${esc(urls.meta)}/conversa" target="_blank">conversa (${esc(urls.meta)})</a> · <a href="${esc(urls.ia)}" target="_blank">IA</a></li>
</ol></div>
<form class="cartao" action="/__demo/a1.pfx" method="get"><h2>A1 de teste</h2><p class="cinza">Gera um certificado autoassinado para o CNPJ, com a senha <code>${SENHA_A1_DEMO}</code>.</p>
<p><input name="cnpj" placeholder="CNPJ" required> <input name="nome" placeholder="Nome (opcional)"> <button>Baixar .pfx</button></p></form>
<p class="cinza">Para recomeçar do zero no navegador: apague <code>nofiscal.sessao</code> do localStorage de localhost:3000 (ou abra uma janela anônima).</p>`);
}

export async function iniciarSite({ porta = 3000, apiUrl, supabaseUrl, configJs, metaUrl, urls }) {
  const s = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${porta}`);
    let caminho;
    try { caminho = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end(); return; }

    if (caminho.startsWith('/functions/v1/') || caminho.startsWith('/auth/v1/')) { await proxy(req, res, supabaseUrl + caminho + url.search); return; }
    if (caminho === '/__demo' || caminho === '/__demo/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(painel(urls)); return; }
    if (caminho === '/__demo/a1.pfx') {
      const cnpj = (url.searchParams.get('cnpj') || '').replace(/\D/g, '');
      if (cnpj.length !== 14) { res.writeHead(422, { 'content-type': 'text/plain; charset=utf-8' }).end('CNPJ com 14 dígitos'); return; }
      const pfx = gerarA1({ cnpj, nome: (url.searchParams.get('nome') || 'EMPRESA DEMO').toUpperCase() });
      res.writeHead(200, { 'content-type': 'application/x-pkcs12', 'content-disposition': `attachment; filename="a1-demo-${cnpj}.pfx"` });
      res.end(pfx);
      return;
    }
    // trailingSlash: true — sem extensão e sem barra final → 308 para a versão com barra (antes dos rewrites).
    if (!caminho.endsWith('/') && !extname(caminho)) {
      res.writeHead(308, { location: caminho + '/' + url.search }).end();
      return;
    }
    if (caminho.startsWith('/agentes/fiscal/api/')) {
      const resto = caminho.slice('/agentes/fiscal/api'.length).replace(/\/+$/, '');
      const ativacao = resto === '/v1/onboarding/ativacao';
      await proxy(req, res, apiUrl + '/api' + resto + url.search, ativacao ? { trocarResposta: (t) => trocarWaMe(t, metaUrl) } : {});
      return;
    }
    if (caminho === '/agentes/fiscal/config.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(configJs);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    if (caminho === '/') caminho = '/lp-narrador/cenas-lp/lp-v8.html';
    if (caminho.endsWith('/')) caminho += 'index.html';
    const arquivo = resolve(raiz, '.' + caminho);
    if (!arquivo.startsWith(raiz + sep) || /[\\/](\.git|node_modules|\.env[^\\/]*|_sensivel)([\\/]|$)/i.test(arquivo.slice(raiz.length)) || /funcoes\.local\.vars$/.test(arquivo)) {
      res.writeHead(404).end('não encontrado');
      return;
    }
    try {
      const info = await stat(arquivo);
      if (!info.isFile()) throw new Error('pasta');
      const corpo = await readFile(arquivo);
      res.writeHead(200, { 'content-type': TIPOS[extname(arquivo).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : corpo);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('não encontrado');
    }
  });
  await new Promise((ok, falha) => { s.once('error', falha); s.listen(porta, '127.0.0.1', ok); });
  return s;
}
