// S1 da LP do agente fiscal (.checks/agente-fiscal-lp.md, C1–C3): a página existe, o índice de agentes a lista e o
// layout compartilhado a conhece. C1 e C2 atravessam HTTP: um servidor local serve a raiz do repositório como a
// Vercel (`trailingSlash: true`, pasta/ -> pasta/index.html).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, sep, extname } from 'node:path';
import { repo, ler, texto } from './pagina-falsa.mjs';

const TIPOS = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
let servidor, base;

before(async () => {
  servidor = createServer(async (req, res) => {
    let caminho = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (caminho.endsWith('/')) caminho += 'index.html';
    const arquivo = resolve(repo, '.' + caminho);
    if (!arquivo.startsWith(repo + sep)) { res.writeHead(403).end(); return; }
    try {
      const corpo = await readFile(arquivo);
      res.writeHead(200, { 'content-type': TIPOS[extname(arquivo)] || 'application/octet-stream' }).end(corpo);
    } catch { res.writeHead(404).end('não encontrado'); }
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
});
after(() => new Promise((r) => servidor.close(r)));

async function abrir(rota) {
  const r = await fetch(base + rota);
  return { status: r.status, html: await r.text() };
}
const um = (re, html) => { const m = re.exec(html); return m ? texto(m[1]) : null; };

test('página responde com título e h1', async () => {
  const { status, html } = await abrir('/agentes/fiscal/');
  assert.equal(status, 200);
  assert.equal(um(/<title>([\s\S]*?)<\/title>/, html), 'Agente Fiscal: a NFS-e sai numa mensagem de WhatsApp | Nó Agentes');
  const h1s = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)];
  assert.equal(h1s.length, 1, 'um só h1');
  assert.equal(texto(h1s[0][1]), 'A nota fiscal sai numa mensagem');
});

test('arquivos que a página carrega de agentes/fiscal/ respondem 200', async () => {
  const { html } = await abrir('/agentes/fiscal/');
  const locais = [...html.matchAll(/(?:src|href)="(\/agentes\/fiscal\/[^"?#]+)/g)].map((m) => m[1]);
  for (const f of ['fiscal.css', 'fiscal.js', 'fiscal-fluido.js']) assert.ok(locais.includes('/agentes/fiscal/' + f), f);
  for (const rota of locais) assert.equal((await abrir(rota)).status, 200, rota);
});

test('card no índice de agentes', async () => {
  const { status, html } = await abrir('/agentes/');
  assert.equal(status, 200);
  const cards = [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/g)].map((m) => m[1]);
  const card = cards.find((c) => um(/<h2\b[^>]*>([\s\S]*?)<\/h2>/, c) === 'Agente Fiscal: NFS-e pelo WhatsApp');
  assert.ok(card, 'card com o h2 "Agente Fiscal: NFS-e pelo WhatsApp"');
  const elementos = [...card.matchAll(/<(\w+)\b[^>]*>([^<]*)<\/\1>/g)].map((m) => texto(m[2]));
  assert.ok(elementos.includes('Segundo produto · simulador grátis'), 'selo do card');
  const links = [...card.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({ href: m[1], rotulo: texto(m[2]) }));
  const link = links.find((l) => l.rotulo === 'Simular uma emissão');
  assert.ok(link, 'link "Simular uma emissão"');
  assert.equal(link.href, '/agentes/fiscal/');
  assert.equal((await abrir(link.href)).status, 200, 'o link do card abre a página');
});

test('layout compartilhado em dia', () => {
  assert.match(ler('shared/sync-site-layout.mjs'), /['"]\/agentes\/fiscal\/['"]\s*:\s*['"]agentes\/fiscal\/index\.html['"]/,
    '/agentes/fiscal/ registrado em pages');
  const r = spawnSync(process.execPath, ['shared/sync-site-layout.mjs', '--check'], { cwd: repo, encoding: 'utf8' });
  const saida = (r.stdout + r.stderr).split(/\r?\n/).filter(Boolean);
  // Sai 0 ou 1 só com linhas "Layout out of sync": um erro (marcador faltando) também não listaria a página.
  assert.ok(r.status === 0 || r.status === 1, `status ${r.status}: ${saida.join(' | ')}`);
  for (const l of saida) assert.match(l, /^Layout out of sync: /);
  assert.ok(!saida.includes('Layout out of sync: agentes/fiscal/index.html'), saida.join('\n'));
});
