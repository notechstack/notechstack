// API do app na demonstração (:3001): monta os handlers `export default { fetch }` de app/api/** como a Vercel
// (/api/x/y → app/api/x/y.ts; pastas que começam com "_" ficam de fora) e os rewrites de app/vercel.json para
// /api/v1/nfse/:id. Roda com `node --import tsx`, lançado por demo.mjs com o ambiente local. A rede externa fica
// travada: fetch, http e https só saem para o loopback e host.docker.internal (Landing do lote E).
import { createServer } from 'node:http';
import http from 'node:http';
import https from 'node:https';
import { existsSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pastaApi = resolve(raiz, 'app', 'api');
const porta = Number(process.env.DEMO_API_PORTA || 3001);
const LOCAIS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal']);

function hostDe(alvo) {
  try {
    if (typeof alvo === 'string' || alvo instanceof URL) return new URL(String(alvo)).hostname;
    if (alvo && typeof alvo === 'object') return alvo.hostname || alvo.host || (alvo.url && new URL(alvo.url).hostname) || '';
  } catch { /* alvo estranho: trata como externo */ }
  return '';
}
function barrar(onde, host) {
  console.error(`[api] rede externa bloqueada na demonstração: ${onde} → ${host || '?'}`);
  return new Error(`demonstração: rede externa bloqueada (${host})`);
}
const fetchOriginal = globalThis.fetch;
globalThis.fetch = (alvo, init) => {
  const host = hostDe(alvo instanceof Request ? alvo.url : alvo);
  if (!LOCAIS.has(host)) return Promise.reject(barrar('fetch', host));
  return fetchOriginal(alvo, init);
};
for (const [nome, mod] of [['http', http], ['https', https]]) {
  for (const fn of ['request', 'get']) {
    const original = mod[fn];
    mod[fn] = function (alvo, ...resto) {
      const host = String(hostDe(alvo)).replace(/:\d+$/, '');
      if (!LOCAIS.has(host)) throw barrar(`${nome}.${fn}`, host);
      return original.call(this, alvo, ...resto);
    };
  }
}

// Rewrites de app/vercel.json para a API.
function reescrever(caminho, busca) {
  let m = /^\/api\/v1\/nfse\/([^/]+)\/(cancel|pdf)$/.exec(caminho);
  if (m) { busca.set('id', m[1]); busca.set('acao', m[2]); return '/api/v1/nfse'; }
  m = /^\/api\/v1\/nfse\/([^/]+)$/.exec(caminho);
  if (m) { busca.set('id', m[1]); return '/api/v1/nfse'; }
  return caminho;
}

const modulos = new Map();
async function handler(caminho) {
  if (!/^\/api(\/[\w-]+)+$/.test(caminho) || caminho.split('/').some((s) => s.startsWith('_'))) return null;
  const arquivo = resolve(raiz, 'app' + caminho + '.ts');
  if (!arquivo.startsWith(pastaApi + sep) || !existsSync(arquivo)) return null;
  if (!modulos.has(arquivo)) modulos.set(arquivo, import(pathToFileURL(arquivo).href).then((m) => m.default));
  return modulos.get(arquivo);
}

const servidor = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${porta}`);
  const caminho = reescrever(url.pathname.replace(/\/+$/, ''), url.searchParams);
  try {
    const h = await handler(caminho);
    if (!h || typeof h.fetch !== 'function') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: `sem rota ${caminho} em app/api` } }));
      return;
    }
    const partes = [];
    for await (const c of req) partes.push(c);
    const corpo = Buffer.concat(partes);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v != null && !/^(host|connection|content-length|transfer-encoding)$/i.test(k)) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    const pedido = new Request(`http://localhost:${porta}${caminho}${url.search}`, {
      method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' || !corpo.length ? undefined : corpo
    });
    const resposta = await h.fetch(pedido);
    const cabecalhos = {};
    resposta.headers.forEach((v, k) => { if (!/^(content-length|content-encoding|transfer-encoding)$/i.test(k)) cabecalhos[k] = v; });
    const saida = Buffer.from(await resposta.arrayBuffer());
    res.writeHead(resposta.status, cabecalhos);
    res.end(saida);
    console.log(`[api] ${req.method} ${caminho} → ${resposta.status}`);
  } catch (e) {
    console.error(`[api] ${req.method} ${caminho} falhou: ${e && e.name}`);
    if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'erro na demonstração' } })); }
  }
});
servidor.listen(porta, '127.0.0.1', () => console.log(`[api] app/api em http://localhost:${porta}`));
