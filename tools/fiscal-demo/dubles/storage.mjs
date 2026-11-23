// Dublê do Supabase Storage (:3007) para o módulo Guias: o bucket privado `fiscal-guias` em memória. Fala a mesma API
// que app/api/_lib/guias/storage.ts usa: assinar upload (POST /storage/v1/object/upload/sign/<bucket>/<caminho>), o
// PUT do navegador nessa URL com ?token=, o download com a chave (GET /storage/v1/object/<bucket>/<caminho>) e o link
// assinado de download (POST e GET /storage/v1/object/sign/...). Em http://localhost:3007 lista o que subiu.
import { randomBytes } from 'node:crypto';
import { servidor, lerCorpo, json, html, pagina, esc } from '../http.mjs';

const autorizado = (req) => /^Bearer\s+\S+/i.test(req.headers.authorization || '');

export async function iniciarStorage({ porta = 3007 } = {}) {
  const objetos = new Map();     // "<bucket>/<caminho>" → { bytes, tipo, em }
  const tokens = new Map();      // token → { chave, uso: 'upload' | 'download', expira }
  const novoToken = (chave, uso, segundos) => {
    const t = randomBytes(18).toString('base64url');
    tokens.set(t, { chave, uso, expira: Date.now() + segundos * 1000 });
    return t;
  };
  const valido = (t, chave, uso) => {
    const x = tokens.get(t || '');
    return !!x && x.chave === chave && x.uso === uso && x.expira > Date.now();
  };

  return servidor(porta, async (req, res, url) => {
    const p = decodeURIComponent(url.pathname);
    let m = /^\/storage\/v1\/object\/upload\/sign\/(.+)$/.exec(p);
    if (m && req.method === 'POST') {
      if (!autorizado(req)) { json(res, 401, { message: 'sem chave' }); return; }
      await lerCorpo(req);
      const token = novoToken(m[1], 'upload', 7200);
      json(res, 200, { url: `/object/upload/sign/${m[1]}?token=${token}`, token });
      return;
    }
    if (m && req.method === 'PUT') {
      if (!valido(url.searchParams.get('token'), m[1], 'upload')) { json(res, 403, { message: 'token inválido' }); return; }
      if (objetos.has(m[1])) { json(res, 409, { message: 'já existe' }); return; }
      const bytes = await lerCorpo(req);
      if (bytes.length > 10 * 1024 * 1024) { json(res, 413, { message: 'grande demais' }); return; }
      objetos.set(m[1], { bytes, tipo: req.headers['content-type'] || 'application/octet-stream', em: new Date().toISOString() });
      json(res, 200, { Key: m[1] });
      return;
    }
    m = /^\/storage\/v1\/object\/sign\/(.+)$/.exec(p);
    if (m && req.method === 'POST') {
      if (!autorizado(req)) { json(res, 401, { message: 'sem chave' }); return; }
      const corpo = JSON.parse((await lerCorpo(req)).toString('utf8') || '{}');
      if (!objetos.has(m[1])) { json(res, 404, { message: 'não encontrado' }); return; }
      json(res, 200, { signedURL: `/object/sign/${m[1]}?token=${novoToken(m[1], 'download', Number(corpo.expiresIn) || 60)}` });
      return;
    }
    if (m && req.method === 'GET') {
      const o = objetos.get(m[1]);
      if (!o || !valido(url.searchParams.get('token'), m[1], 'download')) { json(res, 403, { message: 'link inválido ou vencido' }); return; }
      const nome = url.searchParams.get('download');
      res.writeHead(200, { 'content-type': 'application/pdf', ...(nome ? { 'content-disposition': `attachment; filename="${nome.replace(/"/g, '')}"` } : {}) });
      res.end(o.bytes);
      return;
    }
    m = /^\/storage\/v1\/object\/(.+)$/.exec(p);
    if (m && req.method === 'GET') {
      if (!autorizado(req)) { json(res, 401, { message: 'sem chave' }); return; }
      const o = objetos.get(m[1]);
      if (!o) { json(res, 404, { message: 'não encontrado' }); return; }
      res.writeHead(200, { 'content-type': o.tipo, 'content-length': o.bytes.length });
      res.end(o.bytes);
      return;
    }
    if (req.method === 'GET' && p === '/api/objetos') {
      json(res, 200, [...objetos.entries()].map(([k, o]) => ({ chave: k, bytes: o.bytes.length, em: o.em })));
      return;
    }
    if (req.method === 'GET' && p === '/') {
      html(res, 200, pagina('Storage', `<h1>Storage (Supabase dublê)</h1><p class="cinza">Bucket privado fiscal-guias em memória: o navegador sobe cada PDF direto aqui, pela URL assinada.</p>
<div class="cartao"><table>${[...objetos.entries()].map(([k, o]) => `<tr><td class="mono">${esc(k)}</td><td>${o.bytes.length} bytes</td><td class="mono">${esc(o.em.slice(11, 19))}</td></tr>`).join('') || '<tr><td class="cinza">nada ainda</td></tr>'}</table></div>`, { atualizar: 5 }));
      return;
    }
    json(res, 404, { message: 'rota sem dublê' });
  }, 'storage');
}
