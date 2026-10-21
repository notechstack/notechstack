// Utilitários HTTP dos servidores da demonstração (tools/fiscal-demo). Só node:http, sem dependências.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

export const id = (prefixo) => `${prefixo}${randomBytes(8).toString('hex')}`;

export function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', () => resolve(Buffer.concat(partes)));
    req.on('error', reject);
  });
}

export async function lerJson(req) {
  const b = await lerCorpo(req);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); } catch { return null; }
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, x-api-key, anthropic-version, apikey',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
};

export function json(res, status, corpo) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS });
  res.end(JSON.stringify(corpo));
}

export function html(res, status, corpo) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(corpo);
}

export const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Página das ferramentas da demo, com a mesma tipografia do site (fontes servidas pelo :3000).
export function pagina(titulo, corpo, { atualizar = 0 } = {}) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titulo)} · demo nó.fiscal</title>${atualizar ? `<meta http-equiv="refresh" content="${atualizar}">` : ''}
<link rel="stylesheet" href="http://localhost:3000/brand/fonts/fonts.css">
<style>
:root{--tinta:#141414;--osso:#FAFAF7;--cinza:#6B6F76;--borda:#ECEBE6;--ambar:#EDA33B;--verde:#30A46C;--vermelho:#E0543C}
*{box-sizing:border-box}body{margin:0;background:var(--osso);color:var(--tinta);font:300 15px/1.55 'Sora',system-ui,sans-serif}
main{max-width:960px;margin:0 auto;padding:32px 20px 60px}h1{font-weight:800;letter-spacing:-.03em;margin:0 0 4px}
.selo{display:inline-block;padding:4px 10px;border-radius:999px;background:var(--tinta);color:var(--osso);font:600 11px/1.4 'JetBrains Mono',monospace;letter-spacing:.12em;text-transform:uppercase}
.cartao{background:#fff;border-radius:22px;box-shadow:0 8px 24px rgba(20,20,20,.07);padding:18px 20px;margin:14px 0}
.mono,code{font-family:'JetBrains Mono',monospace}table{width:100%;border-collapse:collapse}td,th{padding:8px 6px;border-bottom:1px solid var(--borda);text-align:left;vertical-align:top;font-size:13.5px}
a{color:inherit}button,.btn{display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:10px 20px;border-radius:999px;border:2px solid var(--tinta);background:var(--tinta);color:var(--osso);font:600 14px/1 'Sora',sans-serif;cursor:pointer;text-decoration:none}
input,textarea,select{font:400 15px/1.3 'Sora',sans-serif;padding:10px 12px;border:1.5px solid var(--borda);border-radius:12px;background:var(--osso);min-height:44px}
.cinza{color:var(--cinza)}.codigo{font:700 28px/1 'JetBrains Mono',monospace;letter-spacing:.2em;color:var(--tinta);background:#FCF3E0;padding:6px 12px;border-radius:10px}
</style></head><body><main><p class="selo">demonstração local · dublê</p>${corpo}</main></body></html>`;
}

export function servidor(porta, rotas, nome) {
  const s = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    try {
      await rotas(req, res, new URL(req.url, `http://localhost:${porta}`));
    } catch (e) {
      console.error(`[${nome}] erro`, e && e.message);
      if (!res.headersSent) json(res, 500, { message: 'erro no dublê', detalhe: String(e && e.message) });
    }
  });
  return new Promise((resolve, reject) => {
    s.once('error', reject);
    // Só no loopback: o Docker Desktop alcança 127.0.0.1 do host por host.docker.internal.
    s.listen(porta, '127.0.0.1', () => resolve(s));
  });
}
