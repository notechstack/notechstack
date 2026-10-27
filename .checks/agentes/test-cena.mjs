/* Prova da cena 3D do Escritório nó (frente B): C6–C11, C26-posteres e Rodada 5 (R8, R11–R16).
   A cena vem de agentes/escritorio/escritorio.glb; a bancada tem o canvas da página (375×520).
   Uso: node .checks/agentes/test-cena.mjs            (prova inteira; C9 leva 60 s reais)
        node .checks/agentes/test-cena.mjs --capturas (só C6, C11 e as capturas, para iterar)
        (os pôsteres de agentes/escritorio/ são regravados por gerar-posteres.mjs, no quadro parado
         em que a cena nasce na página; aqui só se confere o tamanho)
   Sobe um servidor estático na raiz da worktree, abre .checks/agentes/cena.html (canvas 375×520)
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
const REGRAVA_POSTERES = false; // ver gerar-posteres.mjs
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
    assert.equal(Math.round(caixa.width), 375); assert.equal(Math.round(caixa.height), 520);
    const ALTURA = 520;
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
    assert.equal(et.auditor.texto, 'nó.auditor'); assert.equal(et.auditor.cor, TOKEN.azul);
    assert.equal(et.vaga.texto, 'criar uma automação'); assert.equal(et.vaga.cor, TOKEN.ambar);
    /* R4 e R9: círculo ≥ 16 px e contorno ≥ 2 px na cor do agente, lidos da textura real */
    for (const [id, cor] of [['fiscal', TOKEN.verde], ['auditor', TOKEN.azul], ['vaga', TOKEN.ambar]]){
      assert(et[id].circuloPx >= 16, `R4 ${id}: círculo com ${et[id].circuloPx} px`);
      assert(et[id].contornoPx >= 2, `R9 ${id}: contorno com ${et[id].contornoPx} px`);
      assert.equal(et[id].corContorno, cor, `R9 ${id}: contorno ${et[id].corContorno}`);
    }
    /* R10: o contorno âmbar da vaga pisca (opacidade muda em 1 s) */
    const op1 = i1.contornoVaga.opacidade;
    await ESPERA(350);
    const op2 = (await page.evaluate(() => cena.inspecionar())).contornoVaga.opacidade;
    await ESPERA(350);
    const op3 = (await page.evaluate(() => cena.inspecionar())).contornoVaga.opacidade;
    assert.equal(i1.contornoVaga.cor, TOKEN.ambar, `R10: contorno ${i1.contornoVaga.cor}`);
    assert(Math.max(op1, op2, op3) - Math.min(op1, op2, op3) > 0.1, `R10: contorno âmbar parado (${op1}, ${op2}, ${op3})`);
    /* R4: o halo de cada etiqueta pulsa (escala muda) */
    const h1 = i1.halos, h3 = (await page.evaluate(() => cena.inspecionar())).halos;
    for (const id of ['fiscal', 'auditor', 'vaga']) assert(Math.abs(h1[id].escala - h3[id].escala) > 1e-3, `R4 ${id}: halo parado`);
    assert.equal(i1.enquadramento, 'tela1');
    await canvas.screenshot({ path: path.join(AQUI, 'cena-tela1.png') });
    const pngTela1 = path.join(tmp, 'poster-escritorio.png');
    await page.addStyleTag({ content: 'html,body{background:transparent!important}' });
    /* pôster sem os chips das mesas: na versão estática as etiquetas são os botões HTML */
    await page.evaluate(() => cena.mostrarEtiquetas(false));
    await ESPERA(250);
    await canvas.screenshot({ path: pngTela1, omitBackground: true });
    await page.evaluate(() => cena.mostrarEtiquetas(true));
    console.log(`PASS C6 mesas em coluna, etiquetas nó.fiscal/nó.auditor/"criar uma automação" em verde/azul/âmbar, enquadramento tela1; R4 círculo ${et.fiscal.circuloPx} px, R9 contorno ${et.fiscal.contornoPx} px, R10 âmbar pisca (${op1} → ${op2} → ${op3})`);

    /* ── R8 · contraste na Tela 1 (canvas da página, 375×520): luminância ≤ 165, desvio ≥ 62 ── */
    const lum = py(`
import sys
from PIL import Image, ImageStat
s=ImageStat.Stat(Image.open(sys.argv[1]).convert('L'))
print('%.1f %.1f' % (s.mean[0], s.stddev[0]))`, path.join(AQUI, 'cena-tela1.png')).split(' ').map(Number);
    assert(lum[0] <= 165, `R8 luminância média ${lum[0]} > 165`);
    assert(lum[1] >= 62, `R8 desvio da luminância ${lum[1]} < 62`);
    console.log(`PASS R8 Tela 1 com luminância média ${lum[0]} (≤ 165) e desvio ${lum[1]} (≥ 62)`);

    if (!SO_CAPTURAS){
      /* ── C7 (R13) · duas pessoas pessoa-fiscal e pessoa-auditor, crachá com a faixa na cor do
            token, sem nomes de pessoa, sem The Office, sem mascote ou animal ── */
      assert.equal(i1.personagens.length, 2);
      const per = Object.fromEntries(i1.personagens.map(x => [x.agente, x]));
      assert.deepEqual(Object.keys(per).sort(), ['auditor', 'fiscal']);
      for (const x of i1.personagens){ assert.equal(x.no, 'pessoa-' + x.agente); assert.equal(Object.hasOwn(x, 'nome'), false); }
      assert.equal(per.fiscal.cracha, TOKEN.verde); assert.equal(per.auditor.cracha, TOKEN.azul);
      /* os nós e materiais do GLB também não podem ter nome de pessoa, The Office nem mascote */
      const glb = fs.readFileSync(path.join(RAIZ, 'agentes/escritorio/escritorio.glb'));
      const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
      const nomesGlb = [...(json.nodes || []), ...(json.materials || []), ...(json.meshes || []), ...(json.animations || [])].map(x => x.name || '');
      assert(nomesGlb.includes('pessoa-fiscal') && nomesGlb.includes('pessoa-auditor'), 'GLB sem pessoa-fiscal/pessoa-auditor');
      for (const n of nomesGlb){
        assert(!/Michael|Dwight|Jim|Pam|Dunder|Scranton|Office/.test(n), 'nó do GLB cita The Office: ' + n);
        assert(!/polvo|mascote|octopus|tent[áa]culo|animal|bicho|gato|cachorro|\bpet\b/i.test(n), 'nó do GLB cita mascote ou animal: ' + n);
      }
      const fontes = fs.readdirSync(path.join(RAIZ, 'agentes/escritorio')).filter(f => /^cena.*\.js$/.test(f));
      assert(fontes.includes('cena.js'));
      for (const f of fontes){
        const src = fs.readFileSync(path.join(RAIZ, 'agentes/escritorio', f), 'utf8');
        assert(!/Michael|Dwight|Jim|Pam|Dunder|Scranton|Office/.test(src), f + ' cita The Office');
        assert(!/\b(polvo|mascote|octopus|tentáculo|tentaculo|animal|bicho|gato|cachorro|pet)\b/i.test(src), f + ' cita mascote ou animal');
        assert(!/\bnome\s*:/.test(src), f + ' dá nome a alguém');
      }
      console.log('PASS C7 (R13) pessoa-fiscal e pessoa-auditor com crachás de faixa verde/azul, sem nomes de pessoa, The Office nem mascote');

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

    /* ── C11 (R11) · fecho(1): a câmera só é arrastada até a sala (altura do quadro varia ≤ 3%),
          sala visível, três cabos #3d63db acesos, placa; fecho(0) volta ── */
    const alturaTela1 = (await page.evaluate(() => cena.inspecionar())).camera.altura;
    await page.evaluate(() => cena.fecho(1));
    await assentar(page);
    await ESPERA(1500);
    const i3 = await page.evaluate(() => cena.inspecionar());
    assert.equal(i3.enquadramento, 'fecho');
    assert(i3.projetados['sala-tech-stack'].visivel, 'sala não visível no fecho');
    const variacao = Math.abs(i3.camera.altura - alturaTela1) / alturaTela1;
    assert(variacao <= .03, `altura do quadro variou ${(variacao * 100).toFixed(1)}% entre a Tela 1 e o fecho`);
    assert.equal(i3.linhas.cor, TOKEN.azul); assert.equal(i3.linhas.cor, '#3d63db');
    assert.equal(i3.linhas.quantidade, 3);
    assert(i3.cabos.every(c => c.cor === '#3d63db'), 'cabo fora de #3d63db');
    assert(i3.cabosAcesos >= 1, 'cabos não acenderam até a sala no fecho');
    assert.equal(i3.placaSala, 'nó tech stack');
    /* ── R12 · os três cabos passam acima do piso ── */
    assert.equal(i3.cabos.length, 3);
    for (const c of i3.cabos) assert(c.yMin > i3.pisoY, `${c.no} desce a ${c.yMin} (piso em ${i3.pisoY})`);
    console.log('PASS R12 três cabos acima do piso (y mínimo ' + i3.cabos.map(c => (c.yMin - i3.pisoY).toFixed(3) + ' m').join(' / ') + ' sobre o piso)');
    await ESPERA(600);
    await page.addStyleTag({ content: 'html,body{background:var(--no-osso)!important}' });
    await canvas.screenshot({ path: path.join(AQUI, 'cena-tela3.png') });
    const pngFecho = path.join(tmp, 'poster-fecho.png');
    await page.addStyleTag({ content: 'html,body{background:transparent!important}' });
    /* pôster sem os chips das mesas: na versão estática as etiquetas são os botões HTML */
    await page.evaluate(() => cena.mostrarEtiquetas(false));
    await ESPERA(250);
    await canvas.screenshot({ path: pngFecho, omitBackground: true });
    await page.evaluate(() => cena.mostrarEtiquetas(true));
    await page.evaluate(() => cena.fecho(0));
    await assentar(page);
    assert.equal((await page.evaluate(() => cena.inspecionar())).enquadramento, 'tela1');
    console.log(`PASS C11 (R11) fecho arrastado até a sala (altura do quadro ${(variacao * 100).toFixed(1)}% ≤ 3%), 3 cabos #3d63db acesos e placa "nó tech stack"; fecho(0) volta a tela1`);

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
      assert(Math.abs(y - .2 * ALTURA) <= 4, `${m} com alvoY .2 ficou em y=${y}`);
      await page.addStyleTag({ content: 'html,body{background:var(--no-osso)!important}' });
      await canvas.screenshot({ path: path.join(AQUI, `cena-foco-${m}.png`) });
    }
    await page.evaluate(() => cena.focar(null));
    await assentar(page);
    assert.equal((await page.evaluate(() => cena.inspecionar())).enquadramento, 'tela1');
    console.log('PASS contrato aoTocarMesa por clique no canvas e focar(mesa, { alvoY }) a 20% da altura');

    /* ── C12-foco · Tela 2 com a gaveta aberta: focar(mesa, { alvoY, alturaVisivel }) põe a pessoa e
          a mesa inteiras na faixa visível; o chip da mesa focada tem o tamanho da Tela 1 (±10%) e os
          outros somem ── */
    const chipTela1 = Object.fromEntries(i1.etiquetasTela.map(e => [e.mesa, e.alturaPx]));
    const FAIXA = { alvoY: .21, alturaVisivel: .42 };
    const [faixaTopo, faixaBase] = [(FAIXA.alvoY - FAIXA.alturaVisivel / 2) * ALTURA, (FAIXA.alvoY + FAIXA.alturaVisivel / 2) * ALTURA];
    const resumoFoco = [];
    for (const m of ['fiscal', 'auditor']){
      await page.evaluate(([m, f]) => cena.focar(m, f), [m, FAIXA]);
      await assentar(page);
      await ESPERA(1200);
      const i4 = await page.evaluate(() => cena.inspecionar());
      assert.equal(i4.enquadramento, m);
      for (const k of ['personagem-' + m, 'mesa-' + m]){
        const y = i4.projetados[k].y;
        assert(i4.projetados[k].visivel && y >= faixaTopo && y <= faixaBase, `C12-foco: ${k} em y=${y}, fora da faixa [${faixaTopo}, ${faixaBase}]`);
      }
      const et4 = Object.fromEntries(i4.etiquetasTela.map(e => [e.mesa, e]));
      const razao = et4[m].alturaPx / chipTela1[m];
      assert(et4[m].visivel && Math.abs(razao - 1) <= .1, `C12-foco: chip de ${m} com ${et4[m].alturaPx} px (Tela 1: ${chipTela1[m]} px)`);
      for (const o of ['fiscal', 'auditor', 'vaga'].filter(x => x !== m)) assert.equal(et4[o].visivel, false, `C12-foco: chip de ${o} visível no foco de ${m}`);
      await page.addStyleTag({ content: 'html,body{background:var(--no-osso)!important}' });
      await canvas.screenshot({ path: path.join(AQUI, `cena-foco-${m}.png`) });
      resumoFoco.push(`${m}: pessoa y=${i4.projetados['personagem-' + m].y}, mesa y=${i4.projetados['mesa-' + m].y}, chip ${et4[m].alturaPx} px (Tela 1: ${chipTela1[m]})`);
    }
    await page.evaluate(() => cena.focar(null));
    await assentar(page);
    await ESPERA(1200);
    const i5 = await page.evaluate(() => cena.inspecionar());
    assert.equal(i5.enquadramento, 'tela1');
    assert(i5.etiquetasTela.every(e => e.visivel), 'C12-foco: as etiquetas não voltaram ao sair do foco');
    assert(Math.abs(i5.camera.altura - i1.camera.altura) < .01, 'C12-foco: o quadro não voltou ao da Tela 1');
    console.log(`PASS C12-foco faixa [${faixaTopo}, ${faixaBase}] px · ${resumoFoco.join(' · ')}; focar(null) volta à Tela 1`);

    /* ── C26-posteres (R15) · 750×1040, renderizados da própria cena ──
       Os WebP são gerados num diretório temporário a cada execução; os arquivos
       versionados em agentes/escritorio/ só são regravados com --posteres (ou
       quando não existem), para a verificação não sujar a árvore. */
    const dir = path.join(RAIZ, 'agentes/escritorio');
    const posteres = [['poster-escritorio.webp', pngTela1], ['poster-fecho.webp', pngFecho]];
    for (const [f, png] of posteres){
      const novo = path.join(tmp, f);
      paraWebp(png, novo);
      assert.equal(tamanhoWebp(novo), '750x1040', f + ' recém-renderizado fora de 750×1040');
      const alvo = path.join(dir, f);
      if (REGRAVA_POSTERES || !fs.existsSync(alvo)) fs.copyFileSync(novo, alvo);
      const t = tamanhoWebp(alvo);
      assert.equal(t, '750x1040', f + ' mede ' + t);
    }
    console.log('PASS C26-posteres (R15) poster-escritorio.webp e poster-fecho.webp em 750×1040' + (REGRAVA_POSTERES ? ' (regravados)' : ''));

    /* ── R16 · um único GLB de no máximo 3 MB ── */
    const tamGlb = fs.statSync(path.join(RAIZ, 'agentes/escritorio/escritorio.glb')).size;
    assert(tamGlb <= 3 * 1024 * 1024, `escritorio.glb tem ${(tamGlb / 1048576).toFixed(2)} MB`);
    const globs = fs.readdirSync(path.join(RAIZ, 'agentes/escritorio')).filter(f => f.endsWith('.glb'));
    assert.deepEqual(globs, ['escritorio.glb'], 'mais de um GLB: ' + globs);
    console.log(`PASS R16 escritorio.glb único, ${(tamGlb / 1048576).toFixed(2)} MB (≤ 3 MB)`);

    /* desempenho (informativo): tempo de montagem e quadros por segundo na bancada */
    await page.evaluate(() => { window.scrollTo(0, 0); cena.fecho(0); cena.focar(null); });
    await ESPERA(800);
    const q0 = await page.evaluate(() => cena.quadros()); await ESPERA(3000);
    const q1 = await page.evaluate(() => cena.quadros());
    const montagem = await page.evaluate(() => window.tempoMontagem);
    const custo = (await page.evaluate(() => cena.inspecionar())).desenho;
    console.log(`INFO montagem ${montagem} ms · ${((q1 - q0) / 3).toFixed(1)} quadros/s na bancada headless · ${custo.chamadas} draw calls · ${custo.triangulos} triângulos`);
    assert.deepEqual(errosPagina, [], 'erros na página');
  } finally {
    await browser.close(); servidor.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(e => { console.error('FAIL', e && e.stack || e); servidor.close(); process.exitCode = 1; });
