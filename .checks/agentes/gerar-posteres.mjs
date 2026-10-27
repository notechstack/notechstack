/* Regrava os pôsteres de /agentes/ a partir da própria cena, no quadro em que ela nasce na página.
   Uso: node .checks/agentes/gerar-posteres.mjs [--png <pasta>]  (--png guarda também os PNG sem perda)

   A página abre com poster-escritorio.webp e, no primeiro gesto, monta a cena parada (relógio da
   animação em 0) e a faz entrar por cima dele num fade. Para essa troca não ter corte, o pôster é
   esse mesmo quadro: cena.html?parado=1, canvas 375×520 @2x (750×1040), sem os chips (na prévia
   as etiquetas são os botões HTML) e com fundo transparente. O do fecho é o mesmo quadro com a
   câmera assentada na sala (versão estática). O da Tela 1 sai também em AVIF, o formato servido
   primeiro (é o LCP da página). */
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('../../app/node_modules/@playwright/test'); }
catch { pw = require('C:/Users/lucca/projetos/notechstack/app/node_modules/@playwright/test'); }
const { chromium } = pw;

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, '..', '..');
const DESTINO = path.join(RAIZ, 'agentes/escritorio');
const ESPERA = ms => new Promise(r => setTimeout(r, ms));
const py = (codigo, ...args) => execFileSync('python', ['-I', '-c', codigo, ...args], { encoding: 'utf8' }).trim();

const TIPOS = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png' };
const servidor = http.createServer((req, res) => {
  try {
    const rota = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (/\.env|_sensivel|\.git\//.test(rota)) throw new Error('negado');
    let f = path.join(RAIZ, rota);
    if (rota.endsWith('/')) f = path.join(f, 'index.html');
    if (!f.startsWith(RAIZ)) throw new Error('fora da raiz');
    res.setHeader('Content-Type', TIPOS[path.extname(f)] || 'application/octet-stream');
    fs.createReadStream(f).on('error', () => { res.statusCode = 404; res.end(); }).pipe(res);
  } catch { res.statusCode = 404; res.end(); }
});

/* espera a câmera assentar: duas projeções seguidas iguais */
async function assentar(page){
  let antes = null;
  for (let i = 0; i < 80; i++){
    const agora = JSON.stringify(await page.evaluate(() => cena.projetar()));
    if (antes === agora) return;
    antes = agora; await ESPERA(120);
  }
  throw new Error('a câmera não assentou');
}
function paraWebp(png, webp){
  return py(`
import sys
from PIL import Image
im=Image.open(sys.argv[1]).convert('RGBA')
im.save(sys.argv[2], 'WEBP', quality=84, method=6)
print('%dx%d' % im.size)`, png, webp);
}
/* AVIF q60: a mesma fidelidade do WebP q84 com ~40% menos bytes (é o LCP da página) */
function paraAvif(png, avif){
  return py(`
import sys
from PIL import Image
im=Image.open(sys.argv[1]).convert('RGBA')
im.save(sys.argv[2], 'AVIF', quality=60, speed=2)
print('%dx%d' % im.size)`, png, avif);
}

await new Promise(r => servidor.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${servidor.address().port}`;
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP || process.env.TMPDIR || '/tmp'), 'posteres-'));
try {
  const page = await browser.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
  const erros = [];
  page.on('pageerror', e => erros.push(e.message));
  await page.goto(base + '/.checks/agentes/cena.html?parado=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.pronto === true || window.erro, null, { timeout: 60000 });
  assert.equal(await page.evaluate(() => window.erro), undefined);
  assert.deepEqual(erros, []);
  const canvas = page.locator('#palco');
  await page.addStyleTag({ content: 'html,body{background:transparent!important}' });
  await page.evaluate(() => cena.mostrarEtiquetas(false));
  await ESPERA(400);

  const saidas = [];
  const tela1 = path.join(tmp, 'poster-escritorio.png');
  await canvas.screenshot({ path: tela1, omitBackground: true });
  saidas.push(['poster-escritorio.webp', tela1]);

  await page.evaluate(() => cena.fecho(1));
  await assentar(page);
  await ESPERA(1500); // os cabos acendem até a sala
  const fecho = path.join(tmp, 'poster-fecho.png');
  await canvas.screenshot({ path: fecho, omitBackground: true });
  saidas.push(['poster-fecho.webp', fecho]);

  const dirPng = process.argv.includes('--png') ? process.argv[process.argv.indexOf('--png') + 1] : null;
  for (const [nome, png] of saidas){
    if (dirPng) fs.copyFileSync(png, path.join(dirPng, nome.replace('.webp', '.png')));
    const tamanho = paraWebp(png, path.join(DESTINO, nome));
    assert.equal(tamanho, '750x1040', `${nome} saiu ${tamanho}`);
    console.log(`${nome} ${tamanho} ${(fs.statSync(path.join(DESTINO, nome)).size / 1024).toFixed(1)} KiB`);
  }
  const avif = path.join(DESTINO, 'poster-escritorio.avif');
  assert.equal(paraAvif(tela1, avif), '750x1040');
  console.log(`poster-escritorio.avif 750x1040 ${(fs.statSync(avif).size / 1024).toFixed(1)} KiB`);
} finally {
  await browser.close();
  servidor.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
