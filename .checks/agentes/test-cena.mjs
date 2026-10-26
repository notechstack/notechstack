/* Prova da cena 3D do Escritório nó (frente B): C6–C11 e C26-posteres.
   Uso: node .checks/agentes/test-cena.mjs            (prova inteira; C9 leva 60 s reais)
        node .checks/agentes/test-cena.mjs --capturas (só C6, C11 e as capturas, para iterar)
        node .checks/agentes/test-cena.mjs --posteres (também regrava os WebP em agentes/escritorio/)
   Sobe um servidor estático na raiz da worktree, abre .checks/agentes/cena.html em 375×812
   @2x com o Playwright e afirma o que o checklist .checks/agentes-escritorio.md diz. */
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
const SO_CAPTURAS = process.argv.includes('--capturas');
const REGRAVA_POSTERES = process.argv.includes('--posteres');
const ESPERA = ms => new Promise(r => setTimeout(r, ms));
const py = (codigo, ...args) => execFileSync('python', ['-I', '-c', codigo, ...args], { encoding: 'utf8' }).trim();

/* ── servidor estático: serve a raiz da worktree, inclusive /.checks/, .webp e .mjs ── */
const TIPOS = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg' };
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

/* tokens de marca lidos do arquivo canônico, para comparar as cores das etiquetas */
const tokensCss = fs.readFileSync(path.join(RAIZ, 'brand/tokens/tokens.css'), 'utf8');
const token = nome => tokensCss.match(new RegExp(nome.replace(/-/g, '\\-') + ':\\s*(#[0-9a-fA-F]{6})'))[1].toLowerCase();
const TOKEN = { verde: token('--no-verde'), azul: token('--no-azul'), ambar: token('--no-ambar') };

/* espera a câmera assentar: duas inspeções seguidas iguais */
async function assentar(page){
  let antes = null;
  for (let i = 0; i < 60; i++){
    const agora = JSON.stringify(await page.evaluate(() => cena.inspecionar().projetados));
    if (antes === agora) return;
    antes = agora; await ESPERA(120);
  }
  throw new Error('a câmera não assentou');
}
/* pixels diferentes entre duas capturas numa região, via PIL */
function difere(a, b){
  return Number(py(`
import sys
from PIL import Image, ImageChops
a=Image.open(sys.argv[1]).convert('RGB'); b=Image.open(sys.argv[2]).convert('RGB')
d=ImageChops.difference(a,b).convert('L').point(lambda v: 255 if v>14 else 0)
print(d.histogram()[255])`, a, b));
}
function paraWebp(png, webp){
  py(`
import sys
from PIL import Image
im=Image.open(sys.argv[1]).convert('RGBA')
im.save(sys.argv[2], 'WEBP', quality=84, method=6)
print(im.size)`, png, webp);
}
const tamanhoWebp = f => py(`
import sys
from PIL import Image
im=Image.open(sys.argv[1]); print('%dx%d' % im.size)`, f);

(async () => {
  await new Promise(r => servidor.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP || process.env.TMPDIR || '/tmp'), 'cena-'));
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
    const errosPagina = [];
    page.on('pageerror', e => errosPagina.push(e.message));
    await page.goto(base + '/.checks/agentes/cena.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.pronto === true || window.erro, null, { timeout: 60000 });
    const erro = await page.evaluate(() => window.erro);
    assert.equal(erro, undefined, 'montarEscritorio rejeitou: ' + erro);
    assert.deepEqual(errosPagina, [], 'erros na página');
    const progresso = await page.evaluate(() => window.progresso);
    assert(progresso.length >= 3 && progresso[progresso.length - 1] === 1 && progresso.every((p, i) => i === 0 || p >= progresso[i - 1]), 'aoProgresso sobe de 0 a 1: ' + progresso);
    const canvas = page.locator('#palco');
    const caixa = await canvas.boundingBox();
    assert.equal(Math.round(caixa.width), 375); assert.equal(Math.round(caixa.height), 812);
    await assentar(page);

    /* ── C6 · Tela 1: ordem das mesas, etiquetas e enquadramento ── */
    const i1 = await page.evaluate(() => cena.inspecionar());
    const p = i1.projetados;
    for (const k of ['mesa-fiscal', 'mesa-auditor', 'mesa-vaga', 'recepcao']) assert(p[k] && p[k].visivel, k + ' visível');
    assert(p['mesa-fiscal'].y < p['mesa-auditor'].y, 'fiscal acima do auditor');
    assert(p['mesa-auditor'].y < p['mesa-vaga'].y, 'auditor acima da vaga');
    assert(p['mesa-vaga'].y < p['recepcao'].y, 'vaga acima da recepção');
    const et = Object.fromEntries(i1.etiquetas.map(e => [e.mesa, e]));
    assert.equal(et.fiscal.texto, 'nó.fiscal'); assert.equal(et.fiscal.cor, TOKEN.verde);
    assert.equal(et.auditor.texto, 'Auditor'); assert.equal(et.auditor.cor, TOKEN.azul);
    assert.equal(et.vaga.texto, 'um problema seu aqui?'); assert.equal(et.vaga.cor, TOKEN.ambar);
    assert.equal(i1.enquadramento, 'tela1');
    await canvas.screenshot({ path: path.join(AQUI, 'cena-tela1.png') });
    const pngTela1 = path.join(tmp, 'poster-escritorio.png');
    await page.addStyleTag({ content: 'html,body{background:transparent!important}' });
    await canvas.screenshot({ path: pngTela1, omitBackground: true });
    console.log('PASS C6 mesas em coluna, etiquetas verde/azul/âmbar, enquadramento tela1');

    if (!SO_CAPTURAS){
      /* ── C7 · dois personagens, cápsula + esfera, crachás, sem nomes nem mascote ── */
      assert.equal(i1.personagens.length, 2);
      const per = Object.fromEntries(i1.personagens.map(x => [x.agente, x]));
      assert.deepEqual(Object.keys(per).sort(), ['auditor', 'fiscal']);
      for (const x of i1.personagens){ assert.equal(x.corpo, 'CapsuleGeometry'); assert.equal(x.cabeca, 'SphereGeometry'); assert.equal(Object.hasOwn(x, 'nome'), false); }
      assert.equal(per.fiscal.cracha, TOKEN.verde); assert.equal(per.auditor.cracha, TOKEN.azul);
      const fontes = fs.readdirSync(path.join(RAIZ, 'agentes/escritorio')).filter(f => /^cena.*\.js$/.test(f));
      assert(fontes.includes('cena.js'));
      for (const f of fontes){
        const src = fs.readFileSync(path.join(RAIZ, 'agentes/escritorio', f), 'utf8');
        assert(!/Michael|Dwight|Jim|Pam|Dunder|Scranton|Office/.test(src), f + ' cita The Office');
        assert(!/\b(polvo|mascote|octopus|tentáculo|tentaculo|animal|bicho|gato|cachorro|pet)\b/i.test(src), f + ' cita mascote ou animal');
        assert(!/\bnome\s*:/.test(src), f + ' dá nome a alguém');
      }
      console.log('PASS C7 dois personagens em cápsula e esfera, crachás verde/azul, sem nomes nem mascote');

      /* ── C8 · "nó." do balcão: plano, sem sombra, sem contorno, mapa do SVG oficial ── */
      const lg = i1.logoBalcao;
      assert.equal(lg.geometria, 'PlaneGeometry'); assert.equal(lg.castShadow, false); assert.equal(lg.receiveShadow, false);
      assert.equal(lg.contorno, false); assert.equal(lg.mapa, '/brand/logo/svg/no-tinta-ponto-azul.svg');
      console.log('PASS C8 logo do balcão plano, sem sombra nem contorno, mapa do SVG oficial');

      /* ── C9 · movimento constante: regiões dos personagens mudam a 1 s e após 60 s ── */
      const regiao = (pt) => ({ x: Math.max(0, pt.x - 40), y: Math.max(0, pt.y - 60), width: 80, height: 110 });
      async function mexe(rotulo){
        const pj = (await page.evaluate(() => cena.inspecionar().projetados));
        const ns = [];
        for (const nome of ['personagem-fiscal', 'personagem-auditor']){
          const clip = regiao(pj[nome]);
          const a = path.join(tmp, `${rotulo}-${nome}-a.png`), b = path.join(tmp, `${rotulo}-${nome}-b.png`);
          await page.screenshot({ path: a, clip });
          await ESPERA(1000);
          await page.screenshot({ path: b, clip });
          const n = difere(a, b);
          assert(n > 40, `${nome} parado (${rotulo}): ${n} px diferentes`);
          ns.push(n);
        }
        return ns;
      }
      const d0 = await mexe('inicio');
      await ESPERA(60000);
      const d60 = await mexe('60s');
      console.log(`PASS C9 personagens em movimento a 1 s (${d0.join('/')} px) e após 60 s (${d60.join('/')} px)`);

      /* ── C10 · fora da tela e aba oculta: quadros() não sobe; ao voltar, sobe ── */
      await page.evaluate(() => window.scrollTo(0, 2400));
      await ESPERA(400);
      const q1 = await page.evaluate(() => cena.quadros()); await ESPERA(1000);
      const q2 = await page.evaluate(() => cena.quadros());
      assert.equal(q2, q1, 'fora da tela ainda renderiza');
      await page.evaluate(() => window.scrollTo(0, 0));
      await ESPERA(1000);
      const q3 = await page.evaluate(() => cena.quadros());
      assert(q3 > q2, 'ao voltar à tela não retomou');
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await ESPERA(300);
      const q4 = await page.evaluate(() => cena.quadros()); await ESPERA(1000);
      const q5 = await page.evaluate(() => cena.quadros());
      assert.equal(q5, q4, 'aba oculta ainda renderiza');
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await ESPERA(1000);
      const q6 = await page.evaluate(() => cena.quadros());
      assert(q6 > q5, 'ao voltar da aba oculta não retomou');
      console.log('PASS C10 pausa fora da tela e com a aba oculta; retoma ao voltar');
    }

    /* ── C11 · fecho(1): recuo, sala visível, três linhas azuis, placa; fecho(0) volta ── */
    await page.evaluate(() => cena.fecho(1));
    await assentar(page);
    const i3 = await page.evaluate(() => cena.inspecionar());
    assert.equal(i3.enquadramento, 'fecho');
    assert(i3.projetados['sala-tech-stack'].visivel, 'sala não visível no fecho');
    assert.equal(i3.linhas.cor, TOKEN.azul); assert.equal(i3.linhas.cor, '#3d63db');
    assert.equal(i3.linhas.quantidade, 3);
    assert.equal(i3.placaSala, 'nó tech stack');
    await ESPERA(600);
    await page.addStyleTag({ content: 'html,body{background:var(--no-osso)!important}' });
    await canvas.screenshot({ path: path.join(AQUI, 'cena-tela3.png') });
    const pngFecho = path.join(tmp, 'poster-fecho.png');
    await page.addStyleTag({ content: 'html,body{background:transparent!important}' });
    await canvas.screenshot({ path: pngFecho, omitBackground: true });
    await page.evaluate(() => cena.fecho(0));
    await assentar(page);
    assert.equal((await page.evaluate(() => cena.inspecionar())).enquadramento, 'tela1');
    console.log('PASS C11 fecho com sala visível, 3 linhas #3d63db e placa "nó tech stack"; fecho(0) volta a tela1');

    /* contrato que a frente A consome: toque no canvas e foco com alvoY (capturas da Tela 2) */
    const pf = (await page.evaluate(() => cena.inspecionar().projetados))['mesa-fiscal'];
    await page.mouse.click(caixa.x + pf.x, caixa.y + pf.y);
    assert.deepEqual(await page.evaluate(() => window.toques), ['fiscal'], 'aoTocarMesa não recebeu fiscal');
    for (const m of ['fiscal', 'auditor']){
      await page.evaluate(m => cena.focar(m, { alvoY: .2 }), m);
      await assentar(page);
      const i2 = await page.evaluate(() => cena.inspecionar());
      assert.equal(i2.enquadramento, m);
      const y = i2.projetados['mesa-' + m].y;
      assert(Math.abs(y - .2 * 812) <= 4, `${m} com alvoY .2 ficou em y=${y}`);
      await page.addStyleTag({ content: 'html,body{background:var(--no-osso)!important}' });
      await canvas.screenshot({ path: path.join(AQUI, `cena-foco-${m}.png`) });
    }
    await page.evaluate(() => cena.focar(null));
    await assentar(page);
    assert.equal((await page.evaluate(() => cena.inspecionar())).enquadramento, 'tela1');
    console.log('PASS contrato aoTocarMesa por clique no canvas e focar(mesa, { alvoY }) a 20% da altura');

    /* ── C26-posteres · 750×1624, renderizados da própria cena ──
       Os WebP são gerados num diretório temporário a cada execução; os arquivos
       versionados em agentes/escritorio/ só são regravados com --posteres (ou
       quando não existem), para a verificação não sujar a árvore. */
    const dir = path.join(RAIZ, 'agentes/escritorio');
    const posteres = [['poster-escritorio.webp', pngTela1], ['poster-fecho.webp', pngFecho]];
    for (const [f, png] of posteres){
      const novo = path.join(tmp, f);
      paraWebp(png, novo);
      assert.equal(tamanhoWebp(novo), '750x1624', f + ' recém-renderizado fora de 750×1624');
      const alvo = path.join(dir, f);
      if (REGRAVA_POSTERES || !fs.existsSync(alvo)) fs.copyFileSync(novo, alvo);
      const t = tamanhoWebp(alvo);
      assert.equal(t, '750x1624', f + ' mede ' + t);
    }
    console.log('PASS C26-posteres poster-escritorio.webp e poster-fecho.webp em 750×1624' + (REGRAVA_POSTERES ? ' (regravados)' : ''));
    assert.deepEqual(errosPagina, [], 'erros na página');
  } finally {
    await browser.close(); servidor.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(e => { console.error('FAIL', e && e.stack || e); servidor.close(); process.exitCode = 1; });
