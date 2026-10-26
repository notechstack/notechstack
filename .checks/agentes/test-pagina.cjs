// Prova da frente A de .checks/agentes-escritorio.md: C1–C5, C11-pagina, C12-pagina, C16-pagina,
// C19, C20, C22–C25, C26a, C27–C32.
//
//   node .checks/agentes/test-pagina.cjs                 → bancada: cena, gaveta e pôsteres de .checks/agentes/stubs/
//   AGENTES_REAL=1 node .checks/agentes/test-pagina.cjs  → módulos e pôsteres reais de /agentes/escritorio/ (depois do merge de B e C)
//
// Sobe um servidor estático próprio na raiz da worktree e usa o Playwright do app.
// Imprime "PASS C<n>" por check e sai com código ≠ 0 no primeiro que falhar.
const { createRequire } = require('node:module');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');

const raiz = path.resolve(__dirname, '../..');
const requerer = createRequire(__filename);
let playwright;
try { playwright = requerer('../../app/node_modules/@playwright/test'); }
catch { playwright = requerer('C:/Users/lucca/projetos/notechstack/app/node_modules/@playwright/test'); }
const { chromium } = playwright;

const REAL = process.env.AGENTES_REAL === '1';
const MODO = REAL ? 'real' : 'stub';
const STUBS = '/.checks/agentes/stubs';
const MODULOS_STUB = {
  cena: `${STUBS}/cena.js`,
  gaveta: `${STUBS}/gaveta.js`,
  gavetaCss: `${STUBS}/gaveta.css`,
  posterEscritorio: `${STUBS}/poster-escritorio.webp`,
  posterFecho: `${STUBS}/poster-fecho.webp`,
};
const CAPTURAS = __dirname;
const MOTIVO = /^\[agentes\] versão estática: (pediu|falha|sem-webgl|movimento-reduzido)$/;

// ── servidor estático ──
const tipos = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.webp': 'image/webp',
  '.png': 'image/png', '.ico': 'image/x-icon', '.xml': 'application/xml', '.txt': 'text/plain',
};
function arquivoDe(rota) {
  if (rota.split('/').some((p) => p.startsWith('.') && p !== '.checks')) return null;
  let f = path.join(raiz, rota.replace(/^\//, ''));
  if (rota.endsWith('/')) f = path.join(f, 'index.html');
  if (!f.startsWith(raiz)) return null;
  // Na bancada, os pôsteres do HTML (img sem JS) caem nos stubs enquanto B não entrega os reais.
  if (!REAL && /^\/agentes\/escritorio\/poster-(escritorio|fecho)\.webp$/.test(rota) && !fs.existsSync(f)) {
    f = path.join(raiz, STUBS.slice(1), path.basename(rota));
  }
  return f;
}
const servidor = http.createServer((req, res) => {
  const rota = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = arquivoDe(rota);
  if (!f || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; res.end(); return; }
  res.setHeader('Content-Type', tipos[path.extname(f)] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(f).pipe(res);
});

// ── three.js: baixa uma vez e serve da memória (o C24 segura e o C25 aborta a rota) ──
const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js';
const cacheCdn = new Map();
async function servirCdn(route) {
  const url = route.request().url();
  if (!cacheCdn.has(url)) {
    const r = await route.fetch();
    cacheCdn.set(url, { status: r.status(), body: await r.body(), contentType: r.headers()['content-type'] || 'text/javascript' });
  }
  const c = cacheCdn.get(url);
  await route.fulfill({ status: c.status, body: c.body, contentType: c.contentType, headers: { 'access-control-allow-origin': '*' } });
}

let base;
let browser;
const motivosVistos = new Set();

function ok(rotulo, detalhe = '') {
  console.log(`PASS ${rotulo}${detalhe ? ` ${detalhe}` : ''}`);
}
const naBancada = (rotulo) => (REAL ? `${rotulo} [real]` : `${rotulo} [stub]`);

// Abre /agentes/ com gravadores de estado instalados antes de qualquer script da página.
async function abrir({ largura = 375, altura = 812, js = true, reduzido = 'no-preference', semWebGL = false, three = 'servir', antes } = {}) {
  const contexto = await browser.newContext({
    viewport: { width: largura, height: altura }, deviceScaleFactor: 1, javaScriptEnabled: js,
    reducedMotion: reduzido, hasTouch: false,
  });
  const pagina = await contexto.newPage();
  const consoles = [];
  const erros = [];
  pagina.on('console', (m) => {
    consoles.push(m.text());
    if (MOTIVO.test(m.text())) motivosVistos.add(m.text().match(MOTIVO)[1]);
  });
  pagina.on('pageerror', (e) => erros.push(e.message));
  await pagina.route(/googletagmanager\.com/, (r) => r.abort());
  let liberarThree = null;
  await pagina.route(/cdn\.jsdelivr\.net\/npm\/three@0\.170\.0\//, async (route) => {
    const url = route.request().url();
    if (url === THREE_URL && three === 'abortar') return route.abort('failed');
    if (url === THREE_URL && three === 'segurar') {
      await new Promise((ok2) => { liberarThree = ok2; });
    }
    return servirCdn(route);
  });
  if (js) {
    if (!REAL) await pagina.addInitScript((m) => { window.__agentesModulos = m; }, MODULOS_STUB);
    if (semWebGL) {
      await pagina.addInitScript(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (tipo, ...resto) {
          if (/webgl/i.test(tipo)) return null;
          return original.call(this, tipo, ...resto);
        };
      });
    }
    await pagina.addInitScript(() => {
      const prova = { classes: [], pct: [], revelado: null, carregandoVisto: false };
      window.__prova = prova;
      const registrar = () => {
        const c = document.documentElement.className;
        if (prova.classes[prova.classes.length - 1] === c) return;
        prova.classes.push(c);
        if (/\bcarregando\b/.test(c)) prova.carregandoVisto = true;
        // Instantâneo do momento em que a tela de carregamento deixa de existir.
        if (prova.carregandoVisto && !/\bcarregando\b/.test(c) && /\banimada\b/.test(c) && !prova.revelado) {
          const recurso = (fim) => performance.getEntriesByType('resource').find((e) => e.name.split('?')[0].endsWith(fim));
          const cfg = window.__agentesModulos || {};
          const pagina = window.__agentesPagina;
          prova.revelado = {
            em: performance.now(),
            sora: document.fonts.check('800 16px Sora'),
            mono: document.fonts.check('500 16px "JetBrains Mono"'),
            three: recurso('three.module.js')?.responseEnd ?? null,
            gaveta: recurso(cfg.gaveta || '/agentes/escritorio/gaveta.js')?.responseEnd ?? null,
            gavetaCss: recurso(cfg.gavetaCss || '/agentes/escritorio/gaveta.css')?.responseEnd ?? null,
            cenaMontada: Boolean(pagina && pagina.cena),
            stubCena: window.__stubCena ? window.__stubCena.resolvidoEm : null,
            quadros: pagina && pagina.cena ? pagina.cena.quadros() : null,
          };
        }
      };
      new MutationObserver(registrar).observe(document, { attributes: true, attributeFilter: ['class'], subtree: true });
      const lerPct = () => {
        const el = document.querySelector('.ag-progresso-pct');
        if (el && /\bcarregando\b/.test(document.documentElement.className)) {
          const v = el.textContent.trim();
          if (prova.pct[prova.pct.length - 1] !== v) prova.pct.push(v);
        }
        if (!prova.revelado) requestAnimationFrame(lerPct);
      };
      requestAnimationFrame(lerPct);
      new MutationObserver(lerPct).observe(document, { childList: true, characterData: true, subtree: true });
    });
  }
  if (antes) await antes(pagina);
  const inicio = Date.now();
  await pagina.goto(`${base}/agentes/`, { waitUntil: 'domcontentloaded' });
  return { contexto, pagina, consoles, erros, inicio, liberarThree: () => liberarThree && liberarThree() };
}

const esperarAnimada = (pagina) => pagina.waitForFunction(() => document.documentElement.classList.contains('animada') && !document.documentElement.classList.contains('carregando'), null, { timeout: 30000 });
const esperarEstatica = (pagina, timeout = 8000) => pagina.waitForFunction(() => document.documentElement.classList.contains('estatica'), null, { timeout });
const inspecionar = (pagina) => pagina.evaluate(() => window.__agentesPagina.cena.inspecionar());
const enquadramento = async (pagina) => (await inspecionar(pagina)).enquadramento;
const rolarPara = (pagina, y) => pagina.evaluate((v) => window.scrollTo({ top: v, behavior: 'instant' }), y);
const gavetaAberta = (pagina) => pagina.evaluate(() => {
  const raiz = document.getElementById('gaveta');
  const d = raiz.querySelector('[role="dialog"], dialog, [aria-modal="true"]') || raiz;
  const c = d.getBoundingClientRect();
  return c.height > 0 && getComputedStyle(d).visibility !== 'hidden';
});
const caixaDaGaveta = (pagina) => pagina.evaluate(() => {
  const raiz = document.getElementById('gaveta');
  const d = [...raiz.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"]'), raiz].find((el) => el.offsetHeight > 0 && el.offsetHeight < innerHeight * 0.95);
  const c = d.getBoundingClientRect();
  return { top: c.top, bottom: c.bottom, height: c.height };
});
const botaoFechar = (pagina) => pagina.locator('#gaveta').locator('button[aria-label*="echar" i], button:has-text("×")').first();
async function esperarPara(fn, timeout = 4000, passo = 100) {
  const fim = Date.now() + timeout;
  let ultimo;
  while (Date.now() < fim) {
    ultimo = await fn();
    if (ultimo) return ultimo;
    await new Promise((r) => setTimeout(r, passo));
  }
  return ultimo;
}

// Pôsteres provisórios da bancada (750×1624, sem mascote nem animal): gerados uma vez.
async function garantirPosteresStub() {
  const alvo = (n) => path.join(raiz, STUBS.slice(1), `poster-${n}.webp`);
  if (fs.existsSync(alvo('escritorio')) && fs.existsSync(alvo('fecho'))) return;
  const p = await browser.newPage();
  await p.goto(`${base}/contato/`);
  for (const nome of ['escritorio', 'fecho']) {
    const dados = await p.evaluate((fecho) => {
      const c = document.createElement('canvas');
      c.width = 750; c.height = 1624;
      const x = c.getContext('2d');
      const cor = { fundo: '#FCF3E0', piso: '#F3F2ED', mesa: '#FAFAF7', tinta: '#141414', cinza: '#6B6F76', azul: '#3D63DB', verde: '#30A46C', ambar: '#EDA33B', vidro: '#E9EEFB' };
      x.fillStyle = cor.fundo; x.fillRect(0, 0, 750, 1624);
      x.fillStyle = cor.piso;
      x.beginPath(); x.moveTo(375, 120); x.lineTo(740, 760); x.lineTo(375, 1560); x.lineTo(10, 760); x.closePath(); x.fill();
      const mesas = fecho ? [[300, 560, cor.verde], [270, 820, cor.azul], [330, 1080, cor.ambar]] : [[450, 420, cor.verde], [390, 780, cor.azul], [480, 1150, cor.ambar]];
      if (fecho) {
        x.strokeStyle = cor.azul; x.lineWidth = 8;
        for (const [mx, my] of mesas) { x.beginPath(); x.moveTo(mx, my); x.lineTo(600, 420); x.stroke(); }
        x.fillStyle = cor.vidro; x.fillRect(470, 300, 250, 220);
        x.fillStyle = cor.tinta; x.font = '600 30px Sora, sans-serif'; x.fillText('nó tech stack', 495, 420);
      }
      const s = fecho ? 0.7 : 1;
      for (const [mx, my, c2] of mesas) {
        x.fillStyle = cor.mesa; x.fillRect(mx - 150 * s, my - 50 * s, 300 * s, 100 * s);
        x.fillStyle = c2; x.fillRect(mx - 150 * s, my + 42 * s, 300 * s, 8 * s);
      }
      x.fillStyle = cor.mesa; x.fillRect(120, fecho ? 1300 : 1380, 320, 120);
      x.fillStyle = cor.cinza; x.font = '500 22px "JetBrains Mono", monospace';
      x.fillText(`pôster provisório · ${fecho ? 'fecho' : 'escritório'} · stub`, 40, 1590);
      return c.toDataURL('image/webp', 0.85);
    }, nome === 'fecho');
    fs.writeFileSync(alvo(nome), Buffer.from(dados.split(',')[1], 'base64'));
  }
  await p.close();
}

async function principal() {
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  console.log(`# modo: ${MODO}${REAL ? '' : ' (cena, gaveta e pôsteres de .checks/agentes/stubs/)'}`);
  if (!REAL) await garantirPosteresStub();
  const htmlBruto = fs.readFileSync(path.join(raiz, 'agentes/index.html'), 'utf8').replace(/\r\n/g, '\n');
  const servido = await (await fetch(`${base}/agentes/`)).text();

  // ── C1: ordem do conteúdo no HTML servido, antes de qualquer JS ──
  {
    const main = servido.slice(servido.indexOf('<main'), servido.indexOf('</main>'));
    assert(main.length > 0, 'C1: <main> não encontrado');
    const ordem = [
      'NÓ AGENTES',
      '<h1', 'Cada agente resolve um problema da sua empresa.',
      'Por assinatura. Toque numa mesa para ver o agente trabalhando.',
      'data-mesa="fiscal"', 'nó.fiscal',
      'data-mesa="auditor"', 'Auditor',
      'data-mesa="vaga"', 'um problema seu aqui?',
      '<h2', 'Quando forem vários, a gente une tudo num sistema só.',
      'class="ag-cartao" href="/agentes/fiscal/"', 'class="ag-cartao" href="/agentes/auditor/"',
      'href="/contato/">Conte sua ideia<',
    ];
    let i = 0;
    for (const trecho of ordem) {
      const j = main.indexOf(trecho, i);
      assert(j >= 0, `C1: fora de ordem ou ausente: ${trecho}`);
      i = j + trecho.length;
    }
    const { contexto, pagina } = await abrir({ js: false });
    const h1 = (await pagina.locator('h1').innerText()).trim();
    assert.equal(h1, 'Cada agente resolve um problema da sua empresa.');
    for (const [mesa, texto] of [['fiscal', 'nó.fiscal'], ['auditor', 'Auditor'], ['vaga', 'um problema seu aqui?']]) {
      assert.equal((await pagina.locator(`[data-mesa="${mesa}"]`).innerText()).trim(), texto, `C1: texto da mesa ${mesa}`);
    }
    assert.equal(await pagina.locator('.ag-cartao').count(), 2, 'C1: dois cartões');
    assert.equal(await pagina.locator('a:has-text("Conte sua ideia")').last().getAttribute('href'), '/contato/');
    await contexto.close();
    ok('C1');
  }

  // ── C2: cartões ──
  {
    const { contexto, pagina } = await abrir({ js: false });
    const fiscal = pagina.locator('.ag-cartao[href="/agentes/fiscal/"]');
    const auditor = pagina.locator('.ag-cartao[href="/agentes/auditor/"]');
    assert.equal(await fiscal.count(), 1);
    assert.equal(await auditor.count(), 1);
    assert((await fiscal.innerText()).includes('Emite a NFS-e pelo WhatsApp, para MEI e Simples.'), 'C2: linha do fiscal');
    assert((await fiscal.innerText()).includes('nó.fiscal'));
    assert((await auditor.innerText()).includes('Confere se o rastreamento dos seus anúncios conta certo.'), 'C2: linha do auditor');
    assert((await auditor.innerText()).includes('Auditor'));
    assert(!servido.includes('Revisa e organiza'), 'C2: "Revisa e organiza" no HTML');
    assert(!(await pagina.locator('body').innerText()).includes('Revisa e organiza'));
    await contexto.close();
    ok('C2');
  }

  // ── C3: head, telemetria, GTM, noscript e sitemap iguais a 9e83de87 ──
  {
    const git = (arq) => execFileSync('git', ['show', `9e83de87:${arq}`], { cwd: raiz, encoding: 'utf8' }).replace(/\r\n/g, '\n');
    const antigo = git('agentes/index.html');
    const extrair = (h) => ({
      title: h.match(/<title>[\s\S]*?<\/title>/)[0],
      description: h.match(/<meta name="description"[^>]*>/)[0],
      canonical: h.match(/<link rel="canonical"[^>]*>/)[0],
      og: h.match(/<meta property="og:[^>]*>/g),
      twitter: h.match(/<meta name="twitter:[^>]*>/g),
      telemetria: h.match(/<script src="\/shared\/telemetria\.js\?v=3"><\/script>/)[0],
      gtm: h.match(/<script>if\(window\.noMarketingHostAllowed[\s\S]*?<\/script>/)[0],
      noscript: h.match(/<noscript><iframe src="https:\/\/www\.googletagmanager\.com\/ns\.html\?id=GTM-NK87FH8W"[\s\S]*?<\/noscript>/)[0],
    });
    const a = extrair(antigo);
    const n = extrair(htmlBruto);
    for (const k of Object.keys(a)) assert.deepEqual(n[k], a[k], `C3: ${k} mudou`);
    assert(a.gtm.includes('GTM-NK87FH8W') && a.gtm.includes('noMarketingHostAllowed'));
    assert(htmlBruto.indexOf(n.telemetria) < htmlBruto.indexOf(n.gtm), 'C3: telemetria depois do GTM');
    const linhaSitemap = (s) => s.split('\n').find((l) => l.includes('/agentes/</loc>'));
    const sitemapAtual = fs.readFileSync(path.join(raiz, 'sitemap.xml'), 'utf8').replace(/\r\n/g, '\n');
    assert(linhaSitemap(sitemapAtual), 'C3: /agentes/ fora do sitemap');
    assert.equal(linhaSitemap(sitemapAtual), linhaSitemap(git('sitemap.xml')), 'C3: entrada do sitemap mudou');
    ok('C3');
  }

  // ── C4: navbar e rodapé canônicos ──
  {
    const r = spawnSync(process.execPath, ['shared/sync-site-layout.mjs', '--check'], { cwd: raiz, encoding: 'utf8' });
    assert(!/agentes\/index\.html/.test(r.stderr + r.stdout), `C4: --check aponta agentes/index.html: ${r.stderr}`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentes-sync-'));
    const script = fs.readFileSync(path.join(raiz, 'shared/sync-site-layout.mjs'), 'utf8');
    const paginas = [...script.matchAll(/'([\w\-/.]+\.html)'/g)].map((m) => m[1]);
    for (const arq of ['shared/sync-site-layout.mjs', ...paginas]) {
      fs.mkdirSync(path.dirname(path.join(tmp, arq)), { recursive: true });
      fs.copyFileSync(path.join(raiz, arq), path.join(tmp, arq));
    }
    const r2 = spawnSync(process.execPath, [path.join(tmp, 'shared/sync-site-layout.mjs')], { encoding: 'utf8' });
    assert.equal(r2.status, 0, `C4: sync falhou: ${r2.stderr}`);
    assert(fs.readFileSync(path.join(tmp, 'agentes/index.html')).equals(fs.readFileSync(path.join(raiz, 'agentes/index.html'))), 'C4: sync mudou agentes/index.html');
    fs.rmSync(tmp, { recursive: true, force: true });
    ok('C4');
  }

  // ── C5: CSS da página ──
  {
    assert(!htmlBruto.includes('/agentes/auditor/auditor.css'), 'C5: ainda carrega auditor.css');
    for (const css of ['/brand/tokens/tokens.css', '/shared/site.css', '/shared/site-layout.css', '/shared/card-nav.css', '/agentes/agentes.css']) {
      assert(new RegExp(`<link rel="stylesheet" href="${css.replace(/[.]/g, '\\.')}(\\?v=\\d+)?">`).test(htmlBruto), `C5: falta ${css}`);
    }
    const hex = /#[0-9a-fA-F]{3,8}/;
    const agentesCss = fs.readFileSync(path.join(raiz, 'agentes/agentes.css'), 'utf8');
    assert(!hex.test(agentesCss), `C5: hex em agentes.css: ${agentesCss.match(hex)}`);
    const gavetaReal = path.join(raiz, 'agentes/escritorio/gaveta.css');
    const gavetaCss = fs.existsSync(gavetaReal) ? gavetaReal : path.join(raiz, STUBS.slice(1), 'gaveta.css');
    assert(!hex.test(fs.readFileSync(gavetaCss, 'utf8')), `C5: hex em ${path.relative(raiz, gavetaCss)}`);
    ok('C5', fs.existsSync(gavetaReal) ? '' : '(gaveta.css real ainda não existe: conferido o stub)');
  }

  // ── C28: sem JS ──
  {
    const { contexto, pagina } = await abrir({ js: false });
    assert.equal(await pagina.locator('.ag-carregamento').isVisible(), false, 'C28: tela de carregamento visível sem JS');
    for (const sel of ['.ag-rotulo', 'h1', '.ag-sub', '[data-mesa="fiscal"]', '[data-mesa="auditor"]', '[data-mesa="vaga"]', '.ag-fecho h2', '.ag-cartao >> nth=0', '.ag-cartao >> nth=1', '.ag-cta']) {
      const el = pagina.locator(sel).first();
      await el.scrollIntoViewIfNeeded();
      assert(await el.isVisible(), `C28: ${sel} invisível`);
    }
    const cores = await pagina.evaluate(() => {
      const h1 = getComputedStyle(document.querySelector('h1'));
      return { cor: h1.color, fundo: getComputedStyle(document.body).backgroundColor, tamanho: parseFloat(h1.fontSize) };
    });
    assert.notEqual(cores.cor, cores.fundo, 'C28: texto ilegível');
    assert(cores.tamanho >= 24);
    await rolarPara(pagina, 0);
    await pagina.screenshot({ path: path.join(CAPTURAS, 'pagina-sem-js-375.png') });
    await contexto.close();
    ok('C28');
  }

  // ── C27: movimento reduzido ──
  let paginaEstatica;
  {
    const sessao = await abrir({ reduzido: 'reduce' });
    const { pagina, consoles } = sessao;
    await esperarEstatica(pagina);
    const prova = await pagina.evaluate(() => window.__prova);
    assert.equal(prova.carregandoVisto, false, 'C27: houve tela de carregamento');
    assert(consoles.includes('[agentes] versão estática: movimento-reduzido'), 'C27: console sem o motivo');
    assert.equal(await pagina.locator('#escritorio-canvas').isVisible(), false);
    paginaEstatica = sessao;
    ok('C27');
  }

  // ── C26a: versão estática ──
  {
    const { pagina } = paginaEstatica;
    const img = pagina.locator('#escritorio-poster');
    assert(await img.isVisible(), 'C26a: pôster invisível');
    await pagina.waitForFunction(() => document.getElementById('escritorio-poster').complete);
    const p1 = await img.evaluate((el) => ({ src: el.currentSrc || el.src, w: el.naturalWidth, h: el.naturalHeight }));
    assert(/\/poster-escritorio\.webp$/.test(p1.src), `C26a: src ${p1.src}`);
    assert.deepEqual([p1.w, p1.h], [750, 1624], 'C26a: pôster do escritório não é 750×1624');
    const fecho = pagina.locator('#fecho-poster');
    await fecho.scrollIntoViewIfNeeded();
    await pagina.waitForFunction(() => { const i = document.getElementById('fecho-poster'); return i.complete && i.naturalWidth > 0; });
    const p2 = await fecho.evaluate((el) => ({ src: el.currentSrc || el.src, w: el.naturalWidth, h: el.naturalHeight }));
    assert(await fecho.isVisible());
    assert(/\/poster-fecho\.webp$/.test(p2.src), `C26a: src ${p2.src}`);
    assert.deepEqual([p2.w, p2.h], [750, 1624], 'C26a: pôster do fecho não é 750×1624');
    await pagina.screenshot({ path: path.join(CAPTURAS, 'pagina-estatica-fecho-375.png') });
    await rolarPara(pagina, 0);
    await pagina.waitForFunction(() => window.__agentesPagina.gaveta);
    for (const mesa of ['fiscal', 'auditor']) {
      await pagina.locator(`[data-mesa="${mesa}"]`).click();
      assert(await esperarPara(() => gavetaAberta(pagina)), `C26a: gaveta do ${mesa} não abriu na estática`);
      assert.equal(new URL(pagina.url()).pathname, '/agentes/');
      if (!REAL) assert.equal(await pagina.evaluate(() => window.__stubGaveta.estatico), true, 'C26a: gaveta sem estatico:true');
      await pagina.keyboard.press('Escape');
      assert(await esperarPara(async () => !(await gavetaAberta(pagina))), 'C26a: gaveta não fechou');
    }
    await rolarPara(pagina, 0);
    await pagina.screenshot({ path: path.join(CAPTURAS, 'pagina-estatica-375.png') });
    await paginaEstatica.contexto.close();
    ok('C26a');
  }

  // ── C25: import do three abortado; WebGL negado ──
  {
    const { contexto, pagina, consoles } = await abrir({ three: 'abortar' });
    await esperarEstatica(pagina, 5000);
    await pagina.waitForTimeout(300);
    assert.equal(await pagina.locator('.ag-carregamento').isVisible(), false, 'C25: tela de carregamento visível após a falha');
    assert.equal(await pagina.locator('.ag-sem-animacoes').isVisible(), false, 'C25: botão visível');
    assert.equal(await pagina.locator('#escritorio-canvas').isVisible(), false);
    assert(await pagina.locator('#escritorio-poster').isVisible());
    assert(consoles.includes('[agentes] versão estática: falha'), 'C25: console sem "falha"');
    await contexto.close();
    const s2 = await abrir({ semWebGL: true });
    await esperarEstatica(s2.pagina, 5000);
    const prova = await s2.pagina.evaluate(() => window.__prova);
    assert.equal(prova.carregandoVisto, false, 'C25: tela de carregamento sem WebGL');
    assert.equal(await s2.pagina.locator('.ag-sem-animacoes').isVisible(), false);
    assert(s2.consoles.includes('[agentes] versão estática: sem-webgl'), 'C25: console sem "sem-webgl"');
    await s2.contexto.close();
    ok('C25');
  }

  // ── C24: three segurado → "Ver sem animações" aos 4 s ──
  {
    const s = await abrir({ three: 'segurar' });
    const { pagina, consoles } = s;
    await pagina.waitForFunction(() => document.documentElement.classList.contains('carregando'));
    await pagina.waitForTimeout(Math.max(0, 3500 - (Date.now() - s.inicio)));
    assert.equal(await pagina.locator('.ag-sem-animacoes').isVisible(), false, 'C24: botão antes de 4 s');
    await pagina.locator('.ag-sem-animacoes').waitFor({ state: 'visible', timeout: 3000 });
    const decorrido = Date.now() - s.inicio;
    assert(decorrido >= 3900 && decorrido <= 6000, `C24: botão em ${decorrido} ms`);
    await pagina.screenshot({ path: path.join(CAPTURAS, 'pagina-carregando-botao-375.png') });
    await pagina.locator('.ag-sem-animacoes').click();
    const t0 = Date.now();
    await esperarEstatica(pagina, 500);
    assert(Date.now() - t0 < 500, 'C24: estática demorou');
    assert.equal(await pagina.locator('.ag-carregamento').isVisible(), false);
    assert(await pagina.locator('#escritorio-poster').isVisible());
    assert(consoles.includes('[agentes] versão estática: pediu'), 'C24: console sem "pediu"');
    s.liberarThree();
    await pagina.waitForTimeout(REAL ? 6000 : 3000);
    assert.equal(await pagina.locator('#escritorio-canvas').isVisible(), false, 'C24: canvas apareceu depois');
    const fim = await pagina.evaluate(() => ({ cls: document.documentElement.className, cena: Boolean(window.__agentesPagina.cena), stub: window.__stubCena || null }));
    assert(!/animada|carregando/.test(fim.cls), `C24: classes ${fim.cls}`);
    assert.equal(fim.cena, false, 'C24: cena ficou ligada');
    if (!REAL) assert.equal(fim.stub && fim.stub.destruido, true, 'C24: cena montada depois não foi destruída');
    await s.contexto.close();
    ok('C24');
  }

  // ── C29: os quatro motivos ──
  for (const m of ['pediu', 'falha', 'sem-webgl', 'movimento-reduzido']) assert(motivosVistos.has(m), `C29: faltou ${m}`);
  ok('C29');

  // ── C22 + C23: tela de carregamento e o que ela espera ──
  {
    const s = await abrir({
      antes: async (pagina) => {
        if (!REAL) await pagina.addInitScript(() => { window.__stubCenaAtraso = 1200; });
        // gaveta.js e a JetBrains Mono chegam por último: a tela tem de esperar por eles.
        await pagina.route(/\/gaveta\.js$/, async (r) => { await new Promise((ok2) => setTimeout(ok2, 2200)); await r.continue(); });
        await pagina.route(/jetbrains-mono-latin-500-normal\.woff2$/, async (r) => { await new Promise((ok2) => setTimeout(ok2, 2600)); await r.continue(); });
      },
    });
    const { pagina } = s;
    await pagina.waitForFunction(() => document.documentElement.classList.contains('carregando'));
    const tela = pagina.locator('.ag-carregamento');
    assert(await tela.isVisible(), 'C22: tela invisível');
    const caixa = await tela.boundingBox();
    assert(caixa.x <= 0 && caixa.y <= 0 && caixa.width >= 375 && caixa.height >= 812, 'C22: não cobre a viewport');
    const logo = await pagina.locator('.ag-carregamento img').evaluate((i) => ({ src: i.getAttribute('src'), ok: i.complete && i.naturalWidth > 0 }));
    assert(/^\/brand\/logo\/svg\/no-[a-z-]+\.svg$/.test(logo.src), `C22: logo ${logo.src}`);
    await pagina.waitForFunction(() => { const i = document.querySelector('.ag-carregamento img'); return i.complete && i.naturalWidth > 0; });
    const pontos = await pagina.evaluate(() => {
      const ref = document.createElement('i');
      document.body.append(ref);
      const tok = ['--no-azul', '--no-vermelho', '--no-ambar', '--no-verde'].map((v) => { ref.style.color = `var(${v})`; return getComputedStyle(ref).color; });
      ref.remove();
      const ds = [...document.querySelectorAll('.ag-pontos > *')];
      return {
        tok,
        cores: ds.map((d) => getComputedStyle(d).backgroundColor),
        anim: ds.map((d) => d.getAnimations().map((a) => ({ delay: a.effect.getTiming().delay, estado: a.playState }))),
        visiveis: ds.map((d) => d.getBoundingClientRect().width > 0),
      };
    });
    assert.equal(pontos.cores.length, 4, 'C22: não são quatro pontos');
    assert.deepEqual(pontos.cores, pontos.tok, 'C22: cores fora da ordem azul → vermelho → âmbar → verde');
    assert(pontos.anim.every((a) => a.length > 0 && a[0].estado === 'running'), 'C22: pontos parados');
    const atrasos = pontos.anim.map((a) => a[0].delay);
    assert(atrasos.every((d, i) => i === 0 || d > atrasos[i - 1]), `C22: animação fora de ordem ${atrasos}`);
    assert(pontos.visiveis.every(Boolean));
    assert(await pagina.getByText('Montando o escritório…').isVisible(), 'C22: texto');
    await pagina.waitForTimeout(500);
    await pagina.screenshot({ path: path.join(CAPTURAS, 'pagina-carregando-375.png') });
    await esperarAnimada(pagina);
    const prova = await pagina.evaluate(() => window.__prova);
    assert.equal(prova.pct[0], '0%', `C22: progresso começou em ${prova.pct[0]}`);
    assert.equal(prova.pct[prova.pct.length - 1], '100%', `C22: progresso terminou em ${prova.pct[prova.pct.length - 1]}`);
    const nums = prova.pct.map((v) => Number(v.replace('%', '')));
    assert(nums.every((n, i) => i === 0 || n >= nums[i - 1]), `C22: progresso voltou ${prova.pct}`);
    assert(nums.length >= 3, `C22: progresso pulou direto ${prova.pct}`);
    ok('C22', `(progresso ${prova.pct.join(' → ')})`);

    const r = prova.revelado;
    assert(r, 'C23: sem instantâneo do fim do carregamento');
    assert(r.sora && r.mono, `C23: fontes ainda não prontas (Sora ${r.sora}, Mono ${r.mono})`);
    assert(r.three !== null && r.three <= r.em, 'C23: three não tinha chegado');
    assert(r.gaveta !== null && r.gaveta <= r.em, 'C23: gaveta.js não tinha chegado');
    assert(r.gavetaCss !== null && r.gavetaCss <= r.em, 'C23: gaveta.css não tinha chegado');
    assert(r.cenaMontada, 'C23: cena não montada');
    if (!REAL) assert(r.stubCena !== null && r.stubCena <= r.em);
    assert(r.quadros > 0, 'C23: nenhum quadro desenhado');
    const q1 = await pagina.evaluate(() => window.__agentesPagina.cena.quadros());
    await pagina.waitForTimeout(500);
    const q2 = await pagina.evaluate(() => window.__agentesPagina.cena.quadros());
    assert(q2 > q1 && q1 > 0, `C23: quadros não sobem (${q1} → ${q2})`);
    ok(naBancada('C23'), `(gaveta.js e JetBrains Mono atrasadas; quadros ${q1} → ${q2})`);
    await s.contexto.close();
  }

  // ── Sessão animada em 375×812 para os demais checks ──
  const s375 = await abrir({ antes: async (p) => { if (!REAL) await p.addInitScript(() => { window.__stubCenaAtraso = 300; }); } });
  const p = s375.pagina;
  await esperarAnimada(p);
  await p.waitForFunction(() => window.__agentesPagina.gaveta);
  await p.waitForTimeout(400);
  await p.screenshot({ path: path.join(CAPTURAS, 'pagina-tela1-375.png') });

  // ── C11-pagina: rolar até o h2 leva ao fecho; voltar, a tela1 ──
  {
    assert.equal(await enquadramento(p), 'tela1', 'C11-pagina: não começou em tela1');
    await p.evaluate(() => {
      const h2 = document.getElementById('ag-fecho-titulo');
      window.scrollTo({ top: h2.getBoundingClientRect().top + scrollY - innerHeight * 0.4, behavior: 'instant' });
    });
    assert.equal(await esperarPara(async () => ((await enquadramento(p)) === 'fecho' ? 'fecho' : null)), 'fecho', 'C11-pagina: não chegou ao fecho');
    await p.waitForTimeout(500);
    await p.evaluate(() => {
      const h2 = document.getElementById('ag-fecho-titulo');
      window.scrollTo({ top: h2.getBoundingClientRect().top + scrollY - innerHeight * 0.62, behavior: 'instant' });
    });
    await p.waitForTimeout(600);
    await p.screenshot({ path: path.join(CAPTURAS, 'pagina-tela3-375.png') });
    await rolarPara(p, 0);
    assert.equal(await esperarPara(async () => ((await enquadramento(p)) === 'tela1' ? 'tela1' : null)), 'tela1', 'C11-pagina: não voltou a tela1');
    ok(naBancada('C11-pagina'));
  }

  // ── C12-pagina e C16-pagina: câmera na mesa, por botão e por canvas ──
  const fecharComEsc = async () => {
    await p.keyboard.press('Escape');
    assert(await esperarPara(async () => !(await gavetaAberta(p))), 'gaveta não fechou com Esc');
    await p.waitForTimeout(600);
  };
  {
    await p.locator('[data-mesa="fiscal"]').click();
    assert(await esperarPara(() => gavetaAberta(p)), 'C12-pagina: gaveta não abriu');
    assert.equal(await esperarPara(async () => ((await enquadramento(p)) === 'fiscal' ? 'fiscal' : null)), 'fiscal', 'C12-pagina: câmera fora da mesa (botão)');
    assert((await p.locator('#gaveta').innerText()).includes('nó.fiscal — sua NFS-e pelo WhatsApp'), 'C12-pagina: título');
    await fecharComEsc();
    await rolarPara(p, 0);
    await p.waitForTimeout(400);
    const info = await inspecionar(p);
    const caixa = await p.locator('#escritorio-canvas').boundingBox();
    const m = info.projetados['mesa-fiscal'];
    await p.mouse.click(caixa.x + m.x, caixa.y + m.y);
    assert(await esperarPara(() => gavetaAberta(p)), 'C12-pagina: toque no canvas não abriu a gaveta');
    assert.equal(await esperarPara(async () => ((await enquadramento(p)) === 'fiscal' ? 'fiscal' : null)), 'fiscal', 'C12-pagina: câmera fora da mesa (canvas)');
    await fecharComEsc();
    ok(naBancada('C12-pagina'));

    await rolarPara(p, 0);
    await p.locator('[data-mesa="auditor"]').click();
    assert(await esperarPara(() => gavetaAberta(p)), 'C16-pagina: gaveta não abriu');
    assert.equal(await esperarPara(async () => ((await enquadramento(p)) === 'auditor' ? 'auditor' : null)), 'auditor', 'C16-pagina: câmera fora da mesa');
    assert((await p.locator('#gaveta').innerText()).includes('Auditor — seu relatório semanal no WhatsApp'), 'C16-pagina: título');
    await fecharComEsc();
    ok(naBancada('C16-pagina'));
  }

  // ── C20: ×, Esc e toque fora; câmera volta; foco volta; Tab preso ──
  {
    for (const modo of ['×', 'Esc', 'fora']) {
      await rolarPara(p, 0);
      await p.waitForTimeout(300);
      const origem = p.locator('[data-mesa="fiscal"]');
      await origem.focus();
      await p.keyboard.press('Enter');
      assert(await esperarPara(() => gavetaAberta(p)), `C20: não abriu (${modo})`);
      await p.waitForTimeout(900);
      if (modo === '×') {
        for (let i = 0; i < 12; i += 1) {
          await p.keyboard.press(i % 3 === 2 ? 'Shift+Tab' : 'Tab');
          assert(await p.evaluate(() => document.getElementById('gaveta').contains(document.activeElement)), 'C20: Tab saiu da gaveta');
        }
        await botaoFechar(p).click();
      } else if (modo === 'Esc') {
        await p.keyboard.press('Escape');
      } else {
        const g = await caixaDaGaveta(p);
        await p.mouse.click(6, Math.max(100, g.top / 2));
      }
      assert(await esperarPara(async () => !(await gavetaAberta(p))), `C20: não fechou (${modo})`);
      assert(await esperarPara(() => p.evaluate(() => document.activeElement === document.querySelector('[data-mesa="fiscal"]'))), `C20: foco não voltou (${modo})`);
      assert.equal(await esperarPara(async () => ((await enquadramento(p)) === 'tela1' ? 'tela1' : null)), 'tela1', `C20: câmera não voltou (${modo})`);
    }
    ok(naBancada('C20'), '(×, Esc e toque fora)');
  }

  // ── C19: mesa vaga (botão e canvas) vai para /contato/ sem gaveta ──
  {
    let navegou = 0;
    await p.route(/\/contato\/$/, (r) => {
      if (r.request().isNavigationRequest()) { navegou += 1; return r.fulfill({ status: 204, body: '' }); }
      return r.continue();
    });
    await rolarPara(p, 0);
    await p.waitForTimeout(300);
    const vaga = p.locator('[data-mesa="vaga"]');
    assert.equal(await vaga.getAttribute('href'), '/contato/');
    await vaga.click();
    assert(await esperarPara(() => navegou >= 1), 'C19: botão da vaga não navegou para /contato/');
    assert.equal(await gavetaAberta(p), false, 'C19: abriu gaveta (botão)');
    const info = await inspecionar(p);
    const caixa = await p.locator('#escritorio-canvas').boundingBox();
    const m = info.projetados['mesa-vaga'];
    await p.mouse.click(caixa.x + m.x, caixa.y + m.y);
    assert(await esperarPara(() => navegou >= 2), 'C19: toque na mesa vaga do canvas não navegou');
    assert.equal(await gavetaAberta(p), false, 'C19: abriu gaveta (canvas)');
    await p.unroute(/\/contato\/$/);
    ok(naBancada('C19'));
  }

  // ── C31: gaveta ≤ 75% da altura e mesa aproximada acima dela ──
  // Mede logo após abrir e de novo com a conversa inteira na tela (a gaveta cresce até 75%).
  {
    const medirC31 = async (mesa, rotulo) => {
      const g = await caixaDaGaveta(p);
      assert(g.height <= 0.75 * 812 + 0.5, `C31 ${rotulo}: gaveta com ${g.height}px`);
      const caixa = await p.locator('#escritorio-canvas').boundingBox();
      const m = (await inspecionar(p)).projetados[`mesa-${mesa}`];
      const yMesa = caixa.y + m.y;
      const fundoNav = await p.evaluate(() => document.querySelector('.no-card-top').getBoundingClientRect().bottom);
      assert(yMesa < g.top, `C31 ${rotulo}: mesa em ${yMesa.toFixed(0)}px, gaveta começa em ${g.top.toFixed(0)}px`);
      assert(yMesa > fundoNav, `C31 ${rotulo}: mesa escondida sob a navbar (${yMesa.toFixed(0)} ≤ ${fundoNav.toFixed(0)})`);
      return `${rotulo}: gaveta ${g.height.toFixed(0)}px, mesa y=${yMesa.toFixed(0)}, gaveta y=${g.top.toFixed(0)}`;
    };
    const notas = [];
    for (const [mesa, esperas] of [['fiscal', [1400, 9000]], ['auditor', [7000]]]) {
      await rolarPara(p, 0);
      await p.waitForTimeout(300);
      await p.locator(`[data-mesa="${mesa}"]`).click();
      assert(await esperarPara(() => gavetaAberta(p)));
      let decorrido = 0;
      for (const espera of esperas) {
        await p.waitForTimeout(espera - decorrido);
        decorrido = espera;
        notas.push(await medirC31(mesa, `${mesa} ${espera / 1000}s`));
        if (mesa === 'fiscal' && espera === 9000) await p.screenshot({ path: path.join(CAPTURAS, 'pagina-gaveta-375.png') });
      }
      await fecharComEsc();
    }
    ok(naBancada('C31'), `(${notas.join(' · ')})`);
  }

  // ── C30: 375×812 e 390×844 ──
  const medirCelular = async (pagina, largura) => {
    for (const y of [0, 99999]) {
      await rolarPara(pagina, y);
      const r = await pagina.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      assert.equal(r.sw, r.cw, `C30: rolagem horizontal em ${largura}px`);
    }
    for (const sel of ['.no-card-nav', '.no-site-footer']) {
      assert.equal(await pagina.locator(sel).count(), 1, `C30: falta ${sel}`);
      const b = await pagina.locator(sel).boundingBox();
      assert(b && b.x >= 0 && b.x + b.width <= largura + 1, `C30: ${sel} fora da largura`);
    }
    await rolarPara(pagina, 0);
    await pagina.waitForTimeout(300);
    const alvos = ['[data-mesa="fiscal"]', '[data-mesa="auditor"]', '[data-mesa="vaga"]', '.ag-cartao >> nth=0', '.ag-cartao >> nth=1', '.ag-cta'];
    for (const sel of alvos) {
      const b = await pagina.locator(sel).boundingBox();
      assert(b && b.width >= 44 && b.height >= 44, `C30: ${sel} com ${b && `${b.width.toFixed(0)}×${b.height.toFixed(0)}`}`);
    }
    await pagina.locator('[data-mesa="fiscal"]').click();
    assert(await esperarPara(() => gavetaAberta(pagina)));
    await pagina.waitForTimeout(800);
    const x = await botaoFechar(pagina).boundingBox();
    assert(x && x.width >= 44 && x.height >= 44, `C30: × da gaveta com ${x && `${x.width}×${x.height}`}`);
    await pagina.keyboard.press('Escape');
    await esperarPara(async () => !(await gavetaAberta(pagina)));
  };
  {
    await medirCelular(p, 375);
    await s375.contexto.close();
    const s390 = await abrir({ largura: 390, altura: 844, antes: async (pg) => { if (!REAL) await pg.addInitScript(() => { window.__stubCenaAtraso = 300; }); } });
    await esperarAnimada(s390.pagina);
    await s390.pagina.waitForFunction(() => window.__agentesPagina.gaveta);
    await medirCelular(s390.pagina, 390);
    await rolarPara(s390.pagina, 0);
    await s390.pagina.waitForTimeout(400);
    await s390.pagina.screenshot({ path: path.join(CAPTURAS, 'pagina-tela1-390.png') });
    const erros = [...s375.erros, ...s390.erros];
    assert.deepEqual(erros, [], `erros na página: ${erros}`);
    await s390.contexto.close();
    ok('C30', '(375×812 e 390×844)');
  }

  // ── C32: 1440×900 ──
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const pc = await ctx.newPage();
    await pc.route(/googletagmanager\.com/, (r) => r.abort());
    await pc.goto(`${base}/contato/`, { waitUntil: 'domcontentloaded' });
    await pc.locator('.no-site-footer').waitFor({ state: 'attached' });
    const textos = (pg) => pg.evaluate(() => ['.no-card-nav', '.no-site-footer'].map((s) => [...document.querySelectorAll(`${s} a`)].map((a) => `${a.getAttribute('href')}|${a.textContent.trim()}`).join(' ')));
    const ref = { nav: await pc.locator('.no-card-nav').boundingBox(), rodape: await pc.locator('.no-site-footer').boundingBox(), links: await textos(pc) };
    await ctx.close();
    const s = await abrir({ largura: 1440, altura: 900, antes: async (pg) => { if (!REAL) await pg.addInitScript(() => { window.__stubCenaAtraso = 300; }); } });
    const pd = s.pagina;
    await esperarAnimada(pd);
    await pd.waitForTimeout(500);
    for (const y of [0, 99999]) {
      await rolarPara(pd, y);
      const r = await pd.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      assert.equal(r.sw, r.cw, 'C32: rolagem horizontal');
    }
    await rolarPara(pd, 0);
    const nav = await pd.locator('.no-card-nav').boundingBox();
    const rodape = await pd.locator('.no-site-footer').boundingBox();
    for (const k of ['x', 'y', 'width', 'height']) assert(Math.abs(nav[k] - ref.nav[k]) <= 1, `C32: navbar ${k} ${nav[k]} ≠ /contato/ ${ref.nav[k]}`);
    for (const k of ['x', 'width']) assert(Math.abs(rodape[k] - ref.rodape[k]) <= 1, `C32: rodapé ${k} ${rodape[k]} ≠ /contato/ ${ref.rodape[k]}`);
    // Altura do rodapé: em /contato/ o home.min.css aumenta o "↗" do botão WhatsApp (~5 px a mais); tolerância de 8 px.
    assert(Math.abs(rodape.height - ref.rodape.height) <= 8, `C32: rodapé com ${rodape.height}px, /contato/ ${ref.rodape.height}px`);
    assert.deepEqual(await textos(pd), ref.links, 'C32: links da navbar ou do rodapé diferentes de /contato/');
    const c = await pd.locator('#escritorio-canvas').boundingBox();
    const meio = (await pd.evaluate(() => document.documentElement.clientWidth)) / 2;
    assert(c.width <= 720, `C32: canvas com ${c.width}px`);
    assert(Math.abs(c.x + c.width / 2 - meio) <= 1, `C32: canvas fora do centro (${c.x + c.width / 2} vs ${meio})`);
    await pd.screenshot({ path: path.join(CAPTURAS, 'pagina-tela1-1440.png') });
    await pd.evaluate(() => {
      const h2 = document.getElementById('ag-fecho-titulo');
      window.scrollTo({ top: h2.getBoundingClientRect().top + scrollY - innerHeight * 0.62, behavior: 'instant' });
    });
    await pd.waitForTimeout(700);
    await pd.screenshot({ path: path.join(CAPTURAS, 'pagina-tela3-1440.png') });
    assert.deepEqual(s.erros, [], `erros na página: ${s.erros}`);
    await s.contexto.close();
    ok('C32', `(canvas ${c.width}×${c.height.toFixed(0)}, centro ${(c.x + c.width / 2).toFixed(1)} / ${meio})`);
  }
}

principal()
  .then(() => { console.log(`# tudo verde (${MODO})`); })
  .catch((erro) => {
    console.error(`FAIL ${erro.message}`);
    if (!(erro instanceof assert.AssertionError)) console.error(erro);
    process.exitCode = 1;
  })
  .finally(async () => {
    await browser?.close();
    servidor.close();
  });
