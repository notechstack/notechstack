// Prova da frente C (gaveta e mockups de WhatsApp): C12, C13, C14, C15, C16, C17, C18,
// C20-gaveta, C21 e C26b de .checks/agentes-escritorio.md, mais R1 e R6 da rodada 3
// (.tasks/agentes-escritorio.md): título "nó.auditor — …", explicação breve tirada da LP antes
// do mockup, gaveta ≤ 62% de 812 e janela de conversa ≤ 300 px.
// Uso: node .checks/agentes/test-gaveta.mjs  (na raiz da worktree)
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const aqui = path.dirname(fileURLToPath(import.meta.url));
const raiz = path.resolve(aqui, '..', '..');

function playwright() {
  for (const c of [path.join(aqui, '../../app/node_modules/@playwright/test'), 'C:/Users/lucca/projetos/notechstack/app/node_modules/@playwright/test']) {
    try { return require(c); } catch { /* tenta o próximo */ }
  }
  throw new Error('Playwright não encontrado');
}
const { chromium } = playwright();

const tipos = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json' };
const servidor = http.createServer((req, res) => {
  try {
    const rota = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let f = path.join(raiz, rota.endsWith('/') ? rota + 'index.html' : rota);
    if (!f.startsWith(raiz) || rota.includes('..')) throw new Error();
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
    res.setHeader('Content-Type', tipos[path.extname(f)] || 'application/octet-stream');
    fs.createReadStream(f).on('error', () => { res.statusCode = 404; res.end(); }).pipe(res);
  } catch { res.statusCode = 404; res.end(); }
});

const VIEWPORT = { width: 375, height: 812 };
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const capturas = [];
let falhas = 0;
async function check(rotulo, fn) {
  try { await fn(); console.log('PASS', rotulo); }
  catch (e) { falhas += 1; console.log('FAIL', rotulo, '—', e.message); }
}

// Observador de DOM instalado na página: registra, com tempo, cada balão, "digitando…" e passo
// marcado que aparece na conversa. É a prova do que a pessoa vê, independente do código da gaveta.
const OBSERVADOR = `(() => {
  if (window.__observador) window.__observador.disconnect();
  const eventos = window.__eventos = [];
  const conv = document.querySelector('.gv-wa-conversa');
  const t0 = performance.now();
  const reg = (tipo, el) => eventos.push({ t: performance.now() - t0, tipo, lado: el.className.includes('--pessoa') ? 'pessoa' : (el.className.includes('--agente') ? 'agente' : ''), texto: el.innerText, html: el.innerHTML });
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'childList') {
        // balões removidos da conversa = a conversa recomeçou (ou trocou de mesa)
        if (m.target === conv && Array.from(m.removedNodes).some((n) => n.classList && n.classList.contains('gv-msg'))) eventos.push({ t: performance.now() - t0, tipo: 'reinicio' });
        m.addedNodes.forEach((n) => {
          if (!(n instanceof Element)) return;
          if (n.classList.contains('gv-msg')) reg('msg', n);
          else if (n.classList.contains('gv-digitando')) reg('digitando', n);
        });
      } else if (m.type === 'attributes' && m.target.matches('.gv-passos li') && m.target.classList.contains('is-feito') && !m.target.__feito) {
        m.target.__feito = true;
        eventos.push({ t: performance.now() - t0, tipo: 'passo', texto: m.target.innerText });
      }
    }
  });
  mo.observe(conv, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  window.__observador = mo;
})()`;

const eventos = (page) => page.evaluate(() => window.__eventos);
const dialogos = (page) => page.evaluate(() => Array.from(document.querySelectorAll('[role="dialog"]')).filter((d) => !d.hidden && d.getClientRects().length));

// O observador entra antes do toque: o primeiro "digitando…" aparece no mesmo instante da abertura.
async function abrirPelaMesa(page, mesa) {
  await page.evaluate(OBSERVADOR);
  await page.click(`[data-mesa="${mesa}"]`);
  await page.waitForSelector('[role="dialog"]:not([hidden])');
}

async function fecharTudo(page) {
  await page.evaluate(() => window.gaveta.fechar());
  await esperar(400);
}

function lerMensagens(evs) { return evs.filter((e) => e.tipo === 'msg'); }

// Lado geométrico dos balões, medido no DOM
async function lados(page) {
  return page.evaluate(() => {
    const conv = document.querySelector('.gv-wa-conversa').getBoundingClientRect();
    const meio = conv.left + conv.width / 2;
    const cor = (el) => getComputedStyle(el).backgroundColor.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
    return Array.from(document.querySelectorAll('.gv-msg')).map((el) => {
      const r = el.getBoundingClientRect();
      return { texto: el.innerText, centro: r.left + r.width / 2, direita: r.left + r.width / 2 > meio, cor: cor(el), hora: el.querySelector('.gv-hora')?.innerText, ticks: el.querySelector('.gv-ticks')?.innerText };
    });
  });
}

(async () => {
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const URL_BANCADA = base + '/.checks/agentes/gaveta.html';
  const navegador = await chromium.launch({ headless: true });
  const retrospectiva = fs.readFileSync(path.join(raiz, 'agentes/auditor/retrospectiva/index.html'), 'utf8');

  try {
    const contexto = await navegador.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, locale: 'pt-BR' });
    const page = await contexto.newPage();
    const errosPagina = [];
    page.on('pageerror', (e) => errosPagina.push(e.message));
    await page.goto(URL_BANCADA, { waitUntil: 'load' });
    await page.waitForFunction(() => window.gavetaPronta && document.fonts.status === 'loaded');

    // ── C12 ───────────────────────────────────────────────────────────────────
    await check('C12 abrir fiscal: selo DEMONSTRAÇÃO, título, mockup; aoMudar({aberta:true, agente:\'fiscal\'})', async () => {
      await abrirPelaMesa(page, 'fiscal');
      const d = await dialogos(page);
      assert.equal(d.length, 1, 'uma gaveta visível');
      const info = await page.evaluate(() => {
        const dlg = document.querySelector('[role="dialog"]');
        const r = dlg.getBoundingClientRect();
        return {
          selo: dlg.querySelector('.gv-selo')?.innerText, seloFonte: getComputedStyle(dlg.querySelector('.gv-selo')).fontFamily,
          titulo: dlg.querySelector('#' + dlg.getAttribute('aria-labelledby'))?.innerText, tituloFonte: getComputedStyle(dlg.querySelector('.gv-titulo')).fontFamily,
          mockup: !!dlg.querySelector('.gv-wa .gv-wa-cab') && !!dlg.querySelector('.gv-wa-conversa'),
          modal: dlg.getAttribute('aria-modal'), live: dlg.querySelector('.gv-wa-conversa').getAttribute('aria-live'),
          topo: r.top, fundo: r.bottom, altura: r.height, alturaTela: innerHeight,
        };
      });
      assert.equal(info.selo, 'DEMONSTRAÇÃO');
      assert.match(info.seloFonte, /JetBrains Mono/);
      assert.equal(info.titulo, 'nó.fiscal — sua NFS-e pelo WhatsApp');
      assert.match(info.tituloFonte, /Sora/);
      assert.ok(info.mockup, 'mockup de WhatsApp presente');
      assert.equal(info.modal, 'true');
      assert.equal(info.live, 'polite');
      await esperar(400); // fim da animação de entrada
      const r = await page.evaluate(() => document.querySelector('[role="dialog"]').getBoundingClientRect().toJSON());
      assert.ok(r.height <= 0.62 * VIEWPORT.height + 0.5, `altura ${r.height} ≤ 62% de 812 (R6)`);
      assert.ok(Math.abs(r.bottom - VIEWPORT.height) <= 1, `rente ao fundo (bottom ${r.bottom})`);
      const mud = await page.evaluate(() => window.mudancas);
      assert.deepEqual(mud.map((m) => [m.aberta, m.agente]).slice(-1)[0], [true, 'fiscal']);
    });

    // ── R6 (rodada 3) ─────────────────────────────────────────────────────────
    // Explicação breve antes do mockup, tirada da LP; gaveta ≤ 62% de 812; janela ≤ 300 px.
    // texto da LP: o HTML bruto (pega atributos como a meta description) + o texto sem tags (pega
    // parágrafos com <a> no meio)
    const textoDaLp = (html) => html + '\n' + html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
    const lps = {
      fiscal: textoDaLp(fs.readFileSync(path.join(raiz, 'agentes/fiscal/index.html'), 'utf8')),
      auditor: textoDaLp(fs.readFileSync(path.join(raiz, 'agentes/auditor/index.html'), 'utf8')),
    };
    async function conferirR6(page, agente) {
      const info = await page.evaluate(() => {
        const dlg = document.querySelector('[role="dialog"]');
        const ex = dlg.querySelector('.gv-explica');
        const wa = dlg.querySelector('.gv-wa');
        const sonda = document.createElement('span'); sonda.style.color = 'var(--no-cinza)'; document.body.append(sonda);
        const corCinza = getComputedStyle(sonda).color; sonda.remove();
        const est = ex ? getComputedStyle(ex) : null;
        const caixa = (el) => el.getBoundingClientRect().toJSON();
        return ex && {
          texto: ex.innerText.trim(), fonte: est.fontFamily, tamanho: parseFloat(est.fontSize), cor: est.color, corCinza,
          ex: caixa(ex), titulo: caixa(dlg.querySelector('.gv-titulo')), selo: caixa(dlg.querySelector('.gv-selo')), wa: caixa(wa), dlg: caixa(dlg), cta: caixa(dlg.querySelector('.gv-cta')),
          ordem: [...dlg.querySelectorAll('.gv-selo, .gv-titulo, .gv-explica, .gv-wa, .gv-nota:not([hidden]), .gv-cta')].map((e) => e.className.split(' ')[0]),
        };
      });
      assert.ok(info, 'explicação (.gv-explica) presente');
      assert.ok(info.texto.length > 0 && info.texto.length <= 180, `explicação com ${info.texto.length} caracteres (≤ 180): ${info.texto}`);
      const frases = info.texto.split(/[.!?](?:\s+|$)/).filter((f) => f.trim()).length;
      assert.ok(frases <= 2, `${frases} frases (≤ 2)`);
      // sem afirmação nova: o texto está na LP do agente (com a inicial minúscula ou igual)
      const minuscula = info.texto[0].toLowerCase() + info.texto.slice(1);
      assert.ok(lps[agente].includes(info.texto) || lps[agente].includes(minuscula), `explicação copiada de agentes/${agente}/index.html`);
      assert.match(info.fonte, /Sora/, 'Sora');
      assert.ok(info.tamanho >= 15 && info.tamanho <= 16, `corpo ${info.tamanho}px (15–16)`);
      assert.equal(info.cor, info.corCinza, 'cor --no-cinza');
      assert.ok(info.ex.top >= info.titulo.bottom - 1 && info.ex.bottom <= info.wa.top + 1, 'explicação entre o título e o mockup');
      assert.deepEqual(info.ordem.filter((c) => c !== 'gv-nota'), ['gv-selo', 'gv-titulo', 'gv-explica', 'gv-wa', 'gv-cta'], 'ordem: selo → título → explicação → janela → CTA');
      assert.ok(info.dlg.height <= 0.62 * VIEWPORT.height + 0.5, `gaveta ${info.dlg.height}px ≤ 62% de 812`);
      assert.ok(info.wa.height <= 300.5, `janela de conversa ${info.wa.height}px ≤ 300`);
      assert.ok(info.cta.bottom <= VIEWPORT.height + 1 && info.cta.top >= info.wa.bottom, 'CTA à vista, abaixo da janela, sem rolar a gaveta');
      console.log(`     explicação (${agente}, ${info.texto.length} c.):`, info.texto);
    }
    await check('R6 fiscal: explicação breve da LP antes do mockup; gaveta ≤ 62%; janela ≤ 300 px; CTA à vista', async () => {
      await conferirR6(page, 'fiscal');
    });

    // ── C13 ───────────────────────────────────────────────────────────────────
    let evsFiscal = [];
    await check('C13 mockup fiscal: cabeçalho, lados, hora e ✓✓, 5 mensagens na ordem, cada uma depois de "digitando…"', async () => {
      await esperar(9500);
      evsFiscal = await eventos(page);
      const cab = await page.evaluate(() => ({ nome: document.querySelector('.gv-wa-nome').innerText, avatar: document.querySelector('.gv-avatar img')?.getAttribute('src') }));
      assert.equal(cab.nome, 'nó.fiscal');
      assert.match(cab.avatar || '', /^\/brand\/logo\/svg\//, 'avatar é o logo da marca');

      const seq = evsFiscal.filter((e) => e.tipo === 'msg' || e.tipo === 'digitando');
      const msgs = lerMensagens(evsFiscal);
      assert.ok(msgs.length >= 5, `5 mensagens (vieram ${msgs.length})`);
      // cada mensagem i vem logo depois de um "digitando…" do mesmo lado
      for (let i = 0; i < 5; i++) {
        const pos = seq.indexOf(msgs[i]);
        assert.ok(pos > 0 && seq[pos - 1].tipo === 'digitando', `mensagem ${i + 1} depois de digitando…`);
        assert.match(seq[pos - 1].texto, /digitando…/);
        assert.equal(seq[pos - 1].lado, msgs[i].lado, `digitando do lado da mensagem ${i + 1}`);
      }
      const [m1, m2, m3, m4, m5] = msgs;
      assert.equal(m1.lado, 'pessoa'); assert.match(m1.texto, /^nota pra Studio Lima, 350 reais/);
      assert.equal(m2.lado, 'agente');
      for (const t of ['Tomador', 'Studio Lima', 'Valor', 'R$ 350,00', 'Serviço', 'Modelo padrão · 04.01.01', 'Confirmo a emissão?', 'Confirmar emissão', 'Corrigir']) assert.ok(m2.texto.includes(t), `mensagem 2 tem "${t}"`);
      assert.equal(m3.lado, 'pessoa'); assert.match(m3.texto, /^Confirmar emissão/);
      assert.equal(m4.lado, 'agente'); assert.match(m4.texto, /^Emitindo…/);
      const passos = ['Montando a DPS 1.01', 'Assinando com o certificado A1', 'Transmitindo à Sefin Nacional', 'NFS-e autorizada'];
      for (const p of passos) assert.ok(m4.texto.includes(p), `passo "${p}"`);
      const marcados = evsFiscal.filter((e) => e.tipo === 'passo');
      assert.deepEqual(marcados.map((e) => e.texto), passos, 'passos marcados na ordem');
      for (let i = 1; i < marcados.length; i++) assert.ok(marcados[i].t - marcados[i - 1].t >= 250, 'passos marcados um a um, não de uma vez');
      assert.ok(marcados[0].t > m4.t, 'primeiro passo marcado depois da mensagem 4 aparecer');
      assert.equal(m5.lado, 'agente'); assert.match(m5.texto, /^Pronto! NFS-e autorizada\./);
      assert.match(m5.texto, /danfse-\d+\.pdf/); assert.match(m5.texto, /nfse-\d+\.xml/); assert.ok(m5.texto.includes('simulação'), 'carimbo simulação');
      assert.ok(m5.t > marcados[3].t, 'mensagem 5 depois do último passo');

      const geo = await lados(page);
      assert.ok(geo.length >= 5);
      const pessoa = geo.filter((g, i) => msgs[i].lado === 'pessoa');
      const agente = geo.filter((g, i) => msgs[i].lado === 'agente');
      for (const g of pessoa) {
        assert.ok(g.direita, 'balão da pessoa à direita');
        assert.ok(g.cor[1] > g.cor[0] && g.cor[1] > g.cor[2], `balão da pessoa verde (${g.cor})`);
        assert.match(g.hora || '', /^\d\d:\d\d$/, 'hora no balão da pessoa');
        assert.equal(g.ticks, '✓✓');
      }
      for (const g of agente) {
        assert.ok(!g.direita, 'balão do agente à esquerda');
        assert.ok(g.cor.every((c) => c >= 240), `balão do agente branco (${g.cor})`);
      }
      assert.ok(await page.evaluate(() => !document.querySelector('.gv-wa a[href*="wa.me"]')), 'mockup sem link wa.me');
      // R6: a conversa rola dentro da janela e a última mensagem fica visível
      const vis = await page.evaluate(() => { const r = document.querySelector('.gv-wa-rolagem').getBoundingClientRect(); const m = Array.from(document.querySelectorAll('.gv-msg')).pop().getBoundingClientRect(); return { r: r.toJSON(), m: m.toJSON() }; });
      assert.ok(vis.m.bottom <= vis.r.bottom + 1 && vis.m.bottom > vis.r.top, `última mensagem visível na janela (fundo ${vis.m.bottom} dentro de ${vis.r.top}–${vis.r.bottom})`);
      await page.screenshot({ path: path.join(aqui, 'gaveta-fiscal.png') }); capturas.push('gaveta-fiscal.png');
    });

    // ── C14 ───────────────────────────────────────────────────────────────────
    await check('C14 4 s depois da mensagem 5 a conversa volta à mensagem 1 (±300 ms)', async () => {
      await esperar(5500);
      const evs = await eventos(page);
      const msgs = lerMensagens(evs);
      const m5 = msgs[4];
      const reinicio = evs.find((e) => e.tipo === 'reinicio' && e.t > m5.t);
      assert.ok(reinicio, 'a conversa foi limpa depois da mensagem 5');
      const dt = reinicio.t - m5.t;
      assert.ok(Math.abs(dt - 4000) <= 300, `recomeço ${Math.round(dt)} ms depois da mensagem 5`);
      const depois = evs.slice(evs.indexOf(reinicio) + 1); // ordem de registro: o mesmo lote pode ter o mesmo instante
      const m1b = depois.find((e) => e.tipo === 'msg');
      assert.ok(m1b && /^nota pra Studio Lima/.test(m1b.texto), 'primeira mensagem depois do recomeço é a mensagem 1');
      assert.ok(m1b.t - m5.t <= 4300, `mensagem 1 de volta ${Math.round(m1b.t - m5.t)} ms depois da 5`);
      assert.equal(depois[0].tipo, 'digitando', 'digitando… antes da mensagem 1 no recomeço');
    });

    // ── C15 ───────────────────────────────────────────────────────────────────
    await check('C15 botão "Simular uma emissão" → /agentes/fiscal/#simulador', async () => {
      const cta = await page.evaluate(() => { const a = document.querySelector('[role="dialog"] .gv-cta'); const r = a.getBoundingClientRect(); return { texto: a.innerText.trim(), href: a.getAttribute('href'), tag: a.tagName, w: r.width, h: r.height, visivel: r.bottom <= innerHeight }; });
      assert.equal(cta.tag, 'A'); assert.equal(cta.texto, 'Simular uma emissão'); assert.equal(cta.href, '/agentes/fiscal/#simulador');
      assert.ok(cta.h >= 44 && cta.w >= 44 && cta.visivel, 'CTA com alvo de toque ≥ 44 px e visível');
    });

    // ── C16 ───────────────────────────────────────────────────────────────────
    let textoAuditor = '';
    await check('C16 abrir auditor: selo, título, cabeçalho nó. + equipe nó, uma mensagem no formato de textoCopia, números só da retrospectiva', async () => {
      await fecharTudo(page);
      await abrirPelaMesa(page, 'auditor');
      await esperar(3500);
      const evs = await eventos(page);
      const info = await page.evaluate(() => {
        const dlg = document.querySelector('[role="dialog"]');
        const msg = dlg.querySelector('.gv-msg');
        const semHora = (t) => t.split('\n').filter((l) => !/^\s*\d\d:\d\d(\s*✓✓)?\s*$/.test(l)).join('\n'); // a hora do balão não faz parte da mensagem
        return { selo: dlg.querySelector('.gv-selo').innerText, titulo: dlg.querySelector('.gv-titulo').innerText, nome: dlg.querySelector('.gv-wa-nome').innerText, sub: dlg.querySelector('.gv-wa-sub').innerText, avatar: dlg.querySelector('.gv-avatar img').getAttribute('src'),
          texto: msg ? semHora(msg.innerText) : '', negrito: msg ? Array.from(msg.querySelectorAll('b,strong')).map((b) => b.innerText) : [], link: msg?.querySelector('.gv-link, a')?.innerText, msgs: dlg.querySelectorAll('.gv-msg').length };
      });
      assert.equal(info.selo, 'DEMONSTRAÇÃO');
      assert.equal(info.titulo, 'nó.auditor — seu relatório semanal no WhatsApp'); // R1
      assert.equal(info.nome, 'nó.'); assert.equal(info.sub, 'equipe nó');
      assert.match(info.avatar, /^\/brand\/logo\/svg\//);
      const msgs = lerMensagens(evs);
      assert.equal(msgs.length, 1, 'uma única mensagem'); assert.equal(info.msgs, 1);
      assert.equal(msgs[0].lado, 'agente', 'mensagem recebida (lado do agente)');
      const dig = evs.filter((e) => e.tipo === 'digitando');
      assert.equal(dig.length, 1, 'um digitando…'); assert.ok(dig[0].t < msgs[0].t, 'digitando antes da mensagem');
      textoAuditor = info.texto;
      const linhas = textoAuditor.split('\n').map((l) => l.trim()).filter(Boolean);
      assert.match(linhas[0], /^Relatório semanal · .+ \(\d\d\/\d\d a \d\d\/\d\d\)$/, 'primeira linha: ' + linhas[0]);
      assert.ok(info.negrito.some((b) => /^Relatório semanal · /.test(b)), 'título em negrito');
      assert.ok(!/\*/.test(textoAuditor), 'asteriscos viraram negrito');
      const iP = linhas.indexOf('Prioridades');
      assert.ok(iP > 1, 'linha "Prioridades"'); assert.ok(info.negrito.includes('Prioridades'), 'Prioridades em negrito');
      assert.ok(linhas.slice(1, iP).join(' ').length > 40, 'resumo entre o título e as prioridades');
      const iR = linhas.findIndex((l) => l.startsWith('Relatório completo:'));
      assert.ok(iR > iP, 'linha "Relatório completo:"');
      const prios = linhas.slice(iP + 1, iR);
      assert.ok(prios.length >= 1);
      prios.forEach((l, i) => assert.match(l, new RegExp(`^${i + 1}\\. [^:]+: .+$`), 'prioridade: ' + l));
      assert.match(linhas[iR], /^Relatório completo: https?:\/\/\S+$/);
      assert.ok(info.link && info.link.startsWith('http'), 'link visível na linha final');
      // Unresolved 3: todo número da mensagem já aparece na retrospectiva pública (tirando o link)
      const semLink = textoAuditor.replace(/https?:\/\/\S+/g, '');
      const numeros = Array.from(new Set(semLink.match(/\d+(?:[.,]\d+)*/g) || []));
      assert.ok(numeros.length > 0);
      const faltam = numeros.filter((n) => !new RegExp('(?<![\\d.,])' + n.replace(/[.]/g, '\\.') + '(?![\\d.,])').test(retrospectiva));
      assert.deepEqual(faltam, [], 'números que não estão na retrospectiva: ' + faltam.join(', '));
      console.log('     números conferidos na retrospectiva:', numeros.join(', '));
      await page.screenshot({ path: path.join(aqui, 'gaveta-auditor.png') }); capturas.push('gaveta-auditor.png');
    });
    await check('R6 auditor: explicação breve da LP antes do mockup; gaveta ≤ 62%; janela ≤ 300 px; CTA à vista', async () => {
      await conferirR6(page, 'auditor');
    });

    // ── C17 ───────────────────────────────────────────────────────────────────
    await check('C17 nota "Cópia opcional do relatório…" abaixo do mockup do auditor', async () => {
      const n = await page.evaluate(() => { const nota = document.querySelector('[role="dialog"] .gv-nota'); const wa = document.querySelector('[role="dialog"] .gv-wa'); return { texto: nota?.innerText.trim(), oculta: nota?.hidden, topo: nota?.getBoundingClientRect().top, fimMockup: wa.getBoundingClientRect().bottom }; });
      assert.equal(n.texto, 'Cópia opcional do relatório, enviada pela equipe da nó. O relatório chega no e-mail e no painel.');
      assert.ok(!n.oculta && n.topo >= n.fimMockup - 1, 'nota abaixo do mockup');
      const corpo = await page.evaluate(() => { const c = document.querySelector('.gv-corpo'); c.scrollTop = c.scrollHeight; return document.querySelector('.gv-nota').getBoundingClientRect().toJSON(); });
      assert.ok(corpo.bottom <= VIEWPORT.height + 1 && corpo.top >= 0, 'nota alcançável na rolagem do corpo');
      await page.screenshot({ path: path.join(aqui, 'gaveta-auditor-nota.png') }); capturas.push('gaveta-auditor-nota.png');
    });

    // ── C18 ───────────────────────────────────────────────────────────────────
    await check('C18 botão "Diagnosticar grátis" → /agentes/auditor/', async () => {
      const cta = await page.evaluate(() => { const a = document.querySelector('[role="dialog"] .gv-cta'); const r = a.getBoundingClientRect(); return { texto: a.innerText.trim(), href: a.getAttribute('href'), h: r.height, visivel: r.bottom <= innerHeight }; });
      assert.equal(cta.texto, 'Diagnosticar grátis'); assert.equal(cta.href, '/agentes/auditor/'); assert.ok(cta.h >= 44 && cta.visivel);
    });

    // ── C20-gaveta ────────────────────────────────────────────────────────────
    await check('C20-gaveta fecha por ×, Esc e toque fora; foco volta à origem; Tab preso; × ≥ 44×44', async () => {
      await fecharTudo(page);
      const fechada = async () => { await esperar(450); const d = await dialogos(page); assert.equal(d.length, 0, 'gaveta fechada'); const m = await page.evaluate(() => window.mudancas.slice(-1)[0]); assert.deepEqual([m.aberta, m.agente], [false, null]); assert.equal(await page.evaluate(() => document.activeElement?.dataset.mesa), 'fiscal', 'foco de volta ao botão de origem'); };
      // ×
      await abrirPelaMesa(page, 'fiscal');
      const x = await page.evaluate(() => { const b = document.querySelector('[role="dialog"] .gv-fechar'); const r = b.getBoundingClientRect(); return { w: r.width, h: r.height, rotulo: b.getAttribute('aria-label') }; });
      assert.ok(x.w >= 44 && x.h >= 44, `× com ${x.w}×${x.h}`); assert.equal(x.rotulo, 'Fechar');
      await page.click('[role="dialog"] .gv-fechar'); await fechada();
      // Esc
      await abrirPelaMesa(page, 'fiscal'); await esperar(400);
      await page.keyboard.press('Escape'); await fechada();
      // toque fora: um ponto acima da gaveta, longe dos botões das mesas
      await abrirPelaMesa(page, 'fiscal'); await esperar(400);
      const topo = await page.evaluate(() => document.querySelector('[role="dialog"]').getBoundingClientRect().top);
      assert.ok(topo > 40, 'há área livre acima da gaveta');
      await page.mouse.click(VIEWPORT.width - 16, 12); await fechada();
      // toque dentro não fecha
      await abrirPelaMesa(page, 'fiscal'); await esperar(400);
      await page.click('[role="dialog"] .gv-titulo'); await esperar(300);
      assert.equal((await dialogos(page)).length, 1, 'toque dentro não fecha');
      // foco preso
      const dentro = () => page.evaluate(() => document.querySelector('[role="dialog"]').contains(document.activeElement));
      assert.ok(await dentro(), 'foco entra na gaveta ao abrir');
      for (let i = 0; i < 8; i++) { await page.keyboard.press('Tab'); assert.ok(await dentro(), `Tab ${i + 1} fica dentro`); }
      for (let i = 0; i < 8; i++) { await page.keyboard.press('Shift+Tab'); assert.ok(await dentro(), `Shift+Tab ${i + 1} fica dentro`); }
      await fecharTudo(page);
    });

    // ── C21 ───────────────────────────────────────────────────────────────────
    await check('C21 troca de mesa e toque duplo < 300 ms: uma gaveta, a última; nada da conversa anterior em 15 s', async () => {
      await abrirPelaMesa(page, 'fiscal');
      await esperar(2500); // mensagens 1 e 2 do fiscal já na tela
      await page.evaluate(OBSERVADOR);
      await page.click('[data-mesa="auditor"]');
      const d = await dialogos(page);
      assert.equal(d.length, 1, 'uma gaveta');
      assert.equal(await page.evaluate(() => document.querySelector('[role="dialog"] .gv-titulo').innerText), 'nó.auditor — seu relatório semanal no WhatsApp');
      assert.ok(await page.evaluate(() => !document.querySelector('.gv-wa-conversa').innerText.includes('Studio Lima')), 'conversa do fiscal sumiu na troca');
      await esperar(15000);
      const evs = await eventos(page);
      const fiscais = /Studio Lima|Emitindo|Confirmar emissão|NFS-e autorizada|digitando/;
      const vazou = evs.filter((e) => e.tipo === 'msg' && fiscais.test(e.texto.replace('digitando…', '')) && !/Relatório semanal/.test(e.texto));
      assert.deepEqual(vazou.map((e) => e.texto.slice(0, 40)), [], 'nenhuma mensagem do fiscal nos 15 s');
      assert.equal(lerMensagens(evs).length, 1, 'só a mensagem do auditor');
      assert.ok(await page.evaluate(() => !document.querySelector('.gv-wa-conversa').innerText.includes('Studio Lima')));

      // toque duplo na mesma mesa em < 300 ms
      await page.evaluate(OBSERVADOR);
      await page.evaluate(() => { const b = document.querySelector('[data-mesa="fiscal"]'); b.click(); setTimeout(() => b.click(), 120); });
      await esperar(300);
      assert.equal((await dialogos(page)).length, 1, 'uma gaveta depois do toque duplo');
      assert.equal(await page.evaluate(() => document.querySelector('[role="dialog"] .gv-titulo').innerText), 'nó.fiscal — sua NFS-e pelo WhatsApp');
      await esperar(2500);
      const evs2 = await eventos(page);
      const m1 = lerMensagens(evs2).filter((m) => /^nota pra Studio Lima/.test(m.texto));
      assert.equal(m1.length, 1, 'mensagem 1 só uma vez (os temporizadores do primeiro toque foram cancelados)');
      assert.equal(await page.evaluate(() => document.querySelectorAll('.gv-digitando').length) <= 1, true, 'no máximo um digitando…');
      await fecharTudo(page);
    });

    // ── C26b ──────────────────────────────────────────────────────────────────
    await check('C26b estatico:true — conversa inteira de uma vez, sem "digitando…" nem animação', async () => {
      const p2 = await contexto.newPage();
      await p2.goto(URL_BANCADA + '?estatico=1', { waitUntil: 'load' });
      await p2.waitForFunction(() => window.gavetaPronta && document.fonts.status === 'loaded');
      await p2.click('[data-mesa="fiscal"]');
      const imediato = await p2.evaluate(() => ({ msgs: document.querySelectorAll('[role="dialog"] .gv-msg').length, dig: document.querySelectorAll('.gv-digitando').length, texto: document.querySelector('.gv-wa-conversa').innerText, feitos: document.querySelectorAll('.gv-passos li.is-feito').length, html: document.querySelector('.gv-wa-conversa').innerHTML }));
      assert.equal(imediato.msgs, 5, '5 mensagens na hora'); assert.equal(imediato.dig, 0); assert.ok(!imediato.texto.includes('digitando'), 'sem "digitando…"');
      assert.equal(imediato.feitos, 4, 'os 4 passos já marcados');
      for (const t of ['nota pra Studio Lima, 350 reais', 'Confirmo a emissão?', 'Confirmar emissão', 'Emitindo…', 'Pronto! NFS-e autorizada.', 'simulação']) assert.ok(imediato.texto.includes(t), t);
      await esperar(3000);
      const depois = await p2.evaluate(() => ({ html: document.querySelector('.gv-wa-conversa').innerHTML, dig: document.querySelectorAll('.gv-digitando').length }));
      assert.equal(depois.html, imediato.html, 'nada muda com o tempo'); assert.equal(depois.dig, 0);
      await p2.screenshot({ path: path.join(aqui, 'gaveta-fiscal-estatico.png') }); capturas.push('gaveta-fiscal-estatico.png');
      await p2.evaluate(() => window.gaveta.fechar()); await esperar(100);
      await p2.click('[data-mesa="auditor"]');
      const aud = await p2.evaluate(() => ({ msgs: document.querySelectorAll('[role="dialog"] .gv-msg').length, dig: document.querySelectorAll('.gv-digitando').length, texto: document.querySelector('.gv-wa-conversa').innerText }));
      assert.equal(aud.msgs, 1); assert.equal(aud.dig, 0); assert.match(aud.texto, /^Relatório semanal · /);
      await p2.close();
    });

    // desktop (R23): painel encostado à direita, a 24 px da borda
    {
      const p3 = await navegador.newPage({ viewport: { width: 1440, height: 900 } });
      await p3.goto(URL_BANCADA, { waitUntil: 'load' });
      await p3.waitForFunction(() => window.gavetaPronta && document.fonts.status === 'loaded');
      await p3.click('[data-mesa="fiscal"]'); await esperar(9000);
      const r = await p3.evaluate(() => document.querySelector('[role="dialog"]').getBoundingClientRect().toJSON());
      assert.ok(r.width >= 480 && r.width <= 560 && Math.abs(r.right - (1440 - 24)) <= 1, `desktop: ${r.width}px de largura, direita em ${r.right}`);
      await p3.screenshot({ path: path.join(aqui, 'gaveta-desktop.png') }); capturas.push('gaveta-desktop.png');
      await p3.close();
    }

    assert.deepEqual(errosPagina, [], 'sem erros de JS na página');
  } finally {
    await navegador.close();
    servidor.close();
  }
  console.log('capturas:', capturas.map((c) => '.checks/agentes/' + c).join(' '));
  if (falhas) { console.log(`${falhas} check(s) falharam`); process.exitCode = 1; }
})().catch((e) => { console.error(e); servidor.close(); process.exitCode = 1; });
