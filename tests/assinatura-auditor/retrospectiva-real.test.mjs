// Retrospectiva com o diagnóstico real da LP (TASK-mvbcb35pbn0): agentes/auditor/retrospectiva/diagnostico-real.js
// lê sessionStorage.no_auditor_diagnostico (contrato v1) e troca a demonstração pelo site da pessoa.
// Sem jsdom: DOM falso mínimo (só o que o script usa), no padrão do front.test.mjs (vm + window).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const aqui = dirname(fileURLToPath(import.meta.url));
const repo = resolve(aqui, '..', '..');
const pasta = resolve(repo, 'agentes/auditor/retrospectiva');
const js = readFileSync(resolve(pasta, 'diagnostico-real.js'), 'utf8');
const html = readFileSync(resolve(pasta, 'index.html'), 'utf8');

// ── DOM falso ──
function casa(el, comp) {
  // comp: tag? (#id | .classe | [attr] | [attr="v"])*
  const re = /^([a-z][\w-]*)?|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/gy;
  let m, resto = comp;
  const tagM = /^[a-z][\w-]*/.exec(resto);
  if (tagM) { if (el.tag !== tagM[0]) return false; resto = resto.slice(tagM[0].length); }
  while (resto) {
    m = /^#([\w-]+)|^\.([\w-]+)|^\[([\w-]+)(?:="([^"]*)")?\]/.exec(resto);
    if (!m) throw new Error('seletor não suportado: ' + comp);
    if (m[1] !== undefined && el.getAttribute('id') !== m[1]) return false;
    if (m[2] !== undefined && !el.classList.contains(m[2])) return false;
    if (m[3] !== undefined) {
      if (!el.hasAttribute(m[3])) return false;
      if (m[4] !== undefined && el.getAttribute(m[3]) !== m[4]) return false;
    }
    resto = resto.slice(m[0].length);
  }
  void re;
  return true;
}
function casaCadeia(el, partes) {
  if (!casa(el, partes[partes.length - 1])) return false;
  if (partes.length === 1) return true;
  for (let p = el.parent; p; p = p.parent) if (casaCadeia(p, partes.slice(0, -1))) return true;
  return false;
}
class El {
  constructor(tag, attrs = {}, children = []) {
    this.tag = tag; this.attrs = { ...attrs }; this.style = {}; this.children = []; this.parent = null; this.texto = ''; this.ouvintes = {};
    for (const c of children) this.appendChild(typeof c === 'string' ? Object.assign(new El('#text'), { texto: c }) : c);
    this.classList = {
      add: (k) => { const s = new Set((this.attrs.class || '').split(/\s+/).filter(Boolean)); s.add(k); this.attrs.class = [...s].join(' '); },
      contains: (k) => (this.attrs.class || '').split(/\s+/).includes(k)
    };
  }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return k in this.attrs; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parent = null; return c; }
  get firstChild() { return this.children[0] || null; }
  get elementos() { return this.children.filter((c) => c.tag !== '#text'); }
  get textContent() { return this.tag === '#text' ? this.texto : this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children = []; this.appendChild(Object.assign(new El('#text'), { texto: String(v) })); }
  set innerHTML(_) { throw new Error('innerHTML proibido: texto do diagnóstico só por textContent'); }
  addEventListener(tipo, fn) { (this.ouvintes[tipo] ||= []).push(fn); }
  click() { const e = { preventDefault() {} }; for (const fn of this.ouvintes.click || []) fn.call(this, e); }
  *desc() { for (const c of this.elementos) { yield c; yield* c.desc(); } }
  querySelectorAll(sel) { const partes = sel.trim().split(/\s+/); return [...this.desc()].filter((el) => casaCadeia(el, partes)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
const el = (tag, attrs, ...children) => new El(tag, attrs, children);

function selo(txt = 'DEMONSTRAÇÃO') { return el('div', { class: 'topo' }, el('span', { class: 'selo' }, txt)); }
function card(chk, id, titulo, ev, rot) {
  return el('button', { type: 'button', class: 'checagem', 'data-chk': chk, 'aria-expanded': 'false', 'data-checagem': id },
    el('span', { class: 'sm' }), el('span', { class: 'checagem__txt' }, el('b', {}, titulo), el('span', { class: 'ev' }, ev)),
    el('span', { class: 'estado estado--' + chk }, rot));
}
function montarDoc() {
  const DEMO = [['t02', 'escolher-contas'], ['t04', 'lendo'], ['t05', 'capa'], ['t07', 'meta'], ['t-horario', 'horario'], ['t08', 'google'], ['t-caminho', 'caminho'], ['t12', 'pos-venda']];
  const t01 = el('section', { id: 't01', 'data-estado': 'boas-vindas-sem-conexao', class: 'tela' },
    selo(), el('p', { class: 'rot' }, 'Relatório de primeiro uso'),
    el('div', {}, el('p', { class: 'num' }, '10'), el('p', { class: 'num-legenda' }, 'checagens lidas no seu site')),
    el('div', { class: 'resumo' },
      ...[['6', 'ok'], ['2', 'atenção'], ['1', 'problema'], ['1', 'não verif.']].map(([v, r]) => el('div', { class: 'cartao' }, el('span', { class: 'valor' }, v), el('span', { class: 'rot' }, r)))),
    el('div', { class: 'acoes' },
      el('button', { class: 'botao botao--icone', 'data-ir': 't02' }, 'Conectar com o Facebook'),
      el('button', { class: 'botao botao--claro botao--icone', 'data-ir': 't02' }, 'Conectar com o Google'),
      el('a', { href: '#t05', 'data-ir': 't05', class: 'link-site' }, 'Continuar só com o site')));
  const t06 = el('section', { id: 't06', 'data-estado': 'site', class: 'tela' },
    selo(), el('p', { class: 'rot' }, 'Site · 10 checagens'),
    el('div', { class: 'medidor' },
      el('svg', {}, el('circle', { class: 'medidor__trilho' }), el('circle', { class: 'medidor__arco', 'stroke-dashoffset': '0.4' })),
      el('div', { class: 'medidor__txt' }, el('p', { class: 'medidor__num', role: 'img', 'aria-label': '6 de 10 checagens ok' }, el('span', { 'data-medidor': '' }, '6'), el('small', {}, 'de 10 ok')))),
    el('div', { class: 'segmentos' }, ...['ok', 'atencao', 'problema', 'nv'].map((k) => el('i', { class: 'seg--' + k }))),
    el('div', { class: 'filtros' },
      el('button', { type: 'button', class: 'filtro', 'data-filtro': 'todas' }, 'Todas · 10'),
      el('button', { type: 'button', class: 'filtro', 'data-filtro': 'atencao' }, 'Atenção · 2'),
      el('button', { type: 'button', class: 'filtro', 'data-filtro': 'problema' }, 'Problema · 1'),
      el('button', { type: 'button', class: 'filtro', 'data-filtro': 'nv' }, 'Não verif. · 1')),
    el('div', { class: 'cartoes-chk' }, card('ok', 'https', 'Site em HTTPS', 'certificado válido', 'ok'), card('problema', 'tempo_resposta', 'Tempo de resposta', '7,2 s', 'problema')));
  const t13 = el('section', { id: 't13', 'data-estado': 'planos', class: 'tela' }, selo(),
    el('p', { class: 'rot rot-chip' }, 'Próximo passo'), el('h1', { class: 'titulo titulo--g' }, 'Três jeitos de seguir com o agente.'));
  const main = el('main', { id: 'celular' }, el('nav', { class: 'lateral' }), t01, ...DEMO.map(([id, est]) => el('section', { id, 'data-estado': est, class: 'tela' }, selo())), t06, t13);
  const root = el('html', {}, el('body', {}, main));
  root.documentElement = root;
  root.getElementById = (id) => root.querySelector('#' + id) || null;
  root.createElement = (tag) => new El(tag);
  return root;
}
function carregar(doc, armazenado, search = '') {
  const idas = [];
  const trocas = [];
  const ctx = {
    window: {
      sessionStorage: { getItem: (k) => (k === 'no_auditor_diagnostico' ? armazenado : null) }, location: { search, href: '' },
      history: { replaceState: (_e, _t, h) => trocas.push(h) }
    },
    document: doc
  };
  vm.runInNewContext(js, ctx, { filename: 'diagnostico-real.js' });
  // o clique dos botões navega por window.location.href do contexto; aqui gravamos para conferir
  Object.defineProperty(ctx.window.location, 'href', { set: (u) => idas.push(u), get: () => idas.at(-1) || '' });
  return { api: ctx.window.NoDiagnosticoReal, idas, trocas };
}

const DIAG = {
  v: 1, salvo_em: 1760000000000, cache: false,
  report: {
    url: 'https://loja.exemplo.com.br', gerado_em: '2026-10-16T22:00:00Z',
    resumo: { ok: 2, atencao: 1, problema: 1, nao_verificavel: 0 },
    checagens: [
      { id: 'https', titulo: 'Site em HTTPS', status: 'ok', evidencia: 'certificado válido', recomendacao: '' },
      { id: 'gtm', titulo: 'Google Tag Manager instalado', status: 'ok', evidencia: 'GTM-ABC123 encontrado', recomendacao: '' },
      { id: 'duplicidade', titulo: 'Tag repetida', status: 'atencao', evidencia: 'GA4 carregado 2 vezes', recomendacao: 'remova uma' },
      { id: 'tempo_resposta', titulo: 'Tempo de resposta', status: 'problema', evidencia: '7,2 s', recomendacao: 'otimize' }
    ]
  }
};
const telasDemo = ['t02', 't04', 't05', 't07', 't-horario', 't08', 't-caminho', 't12'];

test('sem a chave: nada muda (t02 continua com data-estado, demo intacta, sem modo-real)', () => {
  const doc = montarDoc();
  carregar(doc, null);
  assert.equal(doc.getElementById('t02').getAttribute('data-estado'), 'escolher-contas');
  assert.equal(doc.documentElement.classList.contains('modo-real'), false);
  assert.equal(doc.querySelector('#t01 .num').textContent, '10');
  assert.equal(doc.querySelectorAll('#t01 button[data-ir="t02"]').length, 2);
  assert.equal(doc.querySelector('#t01 .selo').textContent, 'DEMONSTRAÇÃO');
});

test('chave inválida (JSON quebrado, v errado, checagens vazias) → não faz nada', () => {
  for (const ruim of ['{', JSON.stringify({ ...DIAG, v: 2 }), JSON.stringify({ v: 1, report: { checagens: [] } }), JSON.stringify({ v: 1, report: {} })]) {
    const doc = montarDoc();
    carregar(doc, ruim);
    assert.equal(doc.getElementById('t02').getAttribute('data-estado'), 'escolher-contas', 'não muda com ' + ruim);
    assert.equal(doc.documentElement.classList.contains('modo-real'), false);
  }
});

test('com diagnóstico de 4 checagens (2 ok, 1 atenção, 1 problema): t01 mostra 2/1/1/0 e num 4, selos "SEU SITE"', () => {
  const doc = montarDoc();
  carregar(doc, JSON.stringify(DIAG));
  assert.ok(doc.documentElement.classList.contains('modo-real'));
  assert.deepEqual(doc.querySelectorAll('#t01 .resumo .cartao .valor').map((v) => v.textContent), ['2', '1', '1', '0']);
  assert.equal(doc.querySelector('#t01 .num').textContent, '4');
  assert.equal(doc.querySelector('#t01 .selo').textContent, 'SEU SITE');
  assert.equal(doc.querySelector('#t06 .selo').textContent, 'SEU SITE');
  assert.ok(doc.querySelector('#t13 .selo').hasAttribute('hidden'), 'planos é oferta real: sem o selo de demonstração');
});

test('t06: 4 cards no molde dos de demonstração, títulos certos, medidor "2", "de 4 ok", arco 0.50, filtros com contagens reais', () => {
  const doc = montarDoc();
  carregar(doc, JSON.stringify(DIAG));
  const cards = doc.querySelectorAll('#t06 .cartoes-chk .checagem');
  assert.equal(cards.length, 4);
  assert.deepEqual(cards.map((c) => c.querySelector('.checagem__txt b').textContent), DIAG.report.checagens.map((c) => c.titulo));
  assert.deepEqual(cards.map((c) => c.getAttribute('data-chk')), ['ok', 'ok', 'atencao', 'problema']);
  assert.deepEqual(cards.map((c) => c.getAttribute('data-checagem')), ['https', 'gtm', 'duplicidade', 'tempo_resposta']);
  for (const c of cards) {
    assert.equal(c.tag, 'button');
    assert.equal(c.getAttribute('type'), 'button');
    assert.equal(c.getAttribute('aria-expanded'), 'false');
    assert.ok(c.querySelector('.sm'));
    assert.ok(c.querySelector('.checagem__txt .ev'));
    assert.ok(c.querySelector('.estado.estado--' + c.getAttribute('data-chk')));
  }
  assert.equal(cards[2].querySelector('.estado').textContent, 'atenção');
  assert.equal(cards[2].querySelector('.ev').textContent, 'GA4 carregado 2 vezes');
  assert.equal(doc.querySelector('#t06 [data-medidor]').textContent, '2');
  assert.equal(doc.querySelector('#t06 .medidor__num small').textContent, 'de 4 ok');
  assert.equal(doc.querySelector('#t06 .medidor__num').getAttribute('aria-label'), '2 de 4 checagens ok');
  assert.equal(doc.querySelector('#t06 .medidor__arco').getAttribute('stroke-dashoffset'), '0.50');
  assert.equal(doc.querySelector('#t06 .rot').textContent, 'Site · 4 checagens');
  assert.deepEqual(doc.querySelectorAll('#t06 .filtro').map((b) => b.textContent), ['Todas · 4', 'Atenção · 1', 'Problema · 1', 'Não verif. · 0']);
  // rodada 3 (Dwight): o medidor animado (status-mark.js) lê data-ok/data-total; a barra segmentada segue os números reais
  const medidor = doc.querySelector('#t06 [data-medidor]');
  assert.equal(medidor.getAttribute('data-ok'), '2');
  assert.equal(medidor.getAttribute('data-total'), '4');
  assert.deepEqual(doc.querySelectorAll('#t06 .segmentos i').map((i) => i.style.flex), ['2', '1', '1', '0']);
  assert.equal(doc.querySelector('#t06 .segmentos .seg--nv').style.display, 'none', 'segmento zerado some');
  // a recomendação do diagnóstico aparece junto da evidência ao abrir o card
  assert.equal(cards[2].querySelector('.ev--rec').textContent, 'Recomendação: remova uma');
  assert.equal(cards[0].querySelector('.ev--rec'), null, 'sem recomendação, sem linha vazia');
});

test('sequência real: as 8 telas demo perdem data-estado e ficam hidden; t01, t06 e t13 continuam', () => {
  const doc = montarDoc();
  carregar(doc, JSON.stringify(DIAG));
  for (const id of telasDemo) {
    const s = doc.getElementById(id);
    assert.ok(s, id + ' continua no DOM');
    assert.equal(s.hasAttribute('data-estado'), false, id + ' sem data-estado');
    assert.ok(s.hasAttribute('hidden'), id + ' hidden');
  }
  assert.deepEqual(doc.querySelectorAll('section[data-estado]').map((s) => s.getAttribute('id')), ['t01', 't06', 't13']);
});

test('t01: botões de conectar perdem data-ir e no clique vão para o app com utm_* e fbclid; "Continuar só com o site" vai para t06', () => {
  const doc = montarDoc();
  const { idas } = carregar(doc, JSON.stringify(DIAG), '?utm_source=meta&utm_medium=cpc&utm_campaign=auditor%20out&fbclid=abc.123&gclid=nao-vai&url=https%3A%2F%2Fx.com');
  const botoes = doc.querySelectorAll('#t01 button.botao');
  assert.equal(botoes.length, 2);
  for (const b of botoes) assert.equal(b.hasAttribute('data-ir'), false);
  botoes[0].click();
  assert.equal(idas.at(-1), 'https://app.notechstack.com.br/?origem=auditor&utm_source=meta&utm_medium=cpc&utm_campaign=auditor%20out&fbclid=abc.123');
  const cont = doc.querySelector('#t01 a.link-site');
  assert.equal(cont.getAttribute('href'), '#t06');
  assert.equal(cont.getAttribute('data-ir'), 't06');
});

test('texto do diagnóstico nunca vira HTML: título com <img onerror> aparece como texto; status desconhecido = não verificável; sem resumo conta pelas checagens', () => {
  const doc = montarDoc();
  const diag = {
    v: 1, report: {
      checagens: [
        { id: 'x', titulo: '<img src=x onerror=alert(1)>', status: 'estranho', evidencia: '<b>ev</b>' },
        { id: 'y', titulo: 'Ok', status: 'ok', evidencia: '' }
      ]
    }
  };
  carregar(doc, JSON.stringify(diag));
  const b = doc.querySelector('#t06 .cartoes-chk .checagem b');
  assert.equal(b.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(b.elementos.length, 0, 'nenhum elemento criado a partir do título');
  assert.equal(doc.querySelector('#t06 .cartoes-chk .checagem .ev').elementos.length, 0);
  assert.equal(doc.querySelector('#t06 .cartoes-chk .checagem').getAttribute('data-chk'), 'nv');
  assert.equal(doc.querySelector('#t06 .cartoes-chk .checagem .estado').textContent, 'não verificável');
  assert.deepEqual(doc.querySelectorAll('#t01 .resumo .cartao .valor').map((v) => v.textContent), ['1', '0', '0', '1']);
  assert.equal(doc.querySelector('#t06 .medidor__arco').getAttribute('stroke-dashoffset'), '0.50');
});

test('funções puras expostas: ler/contar/destinoApp', () => {
  const { api } = carregar(montarDoc(), null);
  assert.equal(api.CHAVE, 'no_auditor_diagnostico');
  assert.equal(api.ler(null), null);
  assert.equal(api.ler('{"v":1}'), null);
  const d = api.ler(JSON.stringify(DIAG));
  assert.equal(d.checagens.length, 4);
  // objetos criados dentro do vm têm outro protótipo: compara pela forma
  const plano = (o) => JSON.parse(JSON.stringify(o));
  assert.deepEqual(plano(api.contar(d.checagens, d.resumo)), { ok: 2, atencao: 1, problema: 1, nao_verificavel: 0, total: 4 });
  assert.deepEqual(plano(api.contar(d.checagens, null)), { ok: 2, atencao: 1, problema: 1, nao_verificavel: 0, total: 4 });
  assert.equal(api.destinoApp(''), 'https://app.notechstack.com.br/?origem=auditor');
  assert.equal(api.destinoApp('?utm_term=a+b'), 'https://app.notechstack.com.br/?origem=auditor&utm_term=a%20b');
});

// ── modo limite (rodada 5): 3 diagnósticos grátis usados; a LP manda para ?motivo=limite#t13 ──
const ordemDemo = ['t01', ...telasDemo, 't06', 't13'];

test('modo limite (?motivo=limite, sem diagnóstico): só t13 na sequência, selo escondido, textos trocados, abre na t13', () => {
  const doc = montarDoc();
  const { trocas } = carregar(doc, null, '?utm_source=meta&motivo=limite&fbclid=abc');
  assert.ok(doc.documentElement.classList.contains('modo-limite'));
  assert.equal(doc.documentElement.classList.contains('modo-real'), false);
  assert.deepEqual(doc.querySelectorAll('section[data-estado]').map((s) => s.getAttribute('id')), ['t13']);
  for (const id of [...telasDemo, 't01', 't06']) {
    assert.ok(doc.getElementById(id), id + ' continua no DOM');
    assert.ok(doc.getElementById(id).hasAttribute('hidden'), id + ' hidden');
  }
  assert.equal(doc.getElementById('t13').hasAttribute('hidden'), false);
  assert.ok(doc.querySelector('#t13 .selo').hasAttribute('hidden'), 'sem o selo DEMONSTRAÇÃO');
  assert.equal(doc.querySelector('#t13 .rot').textContent, '3 diagnósticos grátis usados');
  assert.equal(doc.querySelector('#t13 h1.titulo').textContent, 'Para seguir auditando, escolha um plano.');
  assert.deepEqual(trocas, ['#t13'], 'abre direto na t13');
  assert.equal(doc.querySelector('#t01 .num').textContent, '10', 't01 de demonstração não é preenchida');
});

test('sem motivo=limite e sem diagnóstico: demonstração igual (outro motivo também não liga o modo limite)', () => {
  for (const search of ['', '?utm_source=meta&fbclid=abc', '?motivo=outro', '?motivo_x=limite']) {
    const doc = montarDoc();
    const { trocas } = carregar(doc, null, search);
    assert.equal(doc.documentElement.classList.contains('modo-limite'), false, search);
    assert.equal(doc.documentElement.classList.contains('modo-real'), false, search);
    assert.deepEqual(doc.querySelectorAll('section[data-estado]').map((s) => s.getAttribute('id')), ordemDemo, search);
    assert.equal(doc.querySelector('#t13 .selo').hasAttribute('hidden'), false, search);
    assert.equal(doc.querySelector('#t13 .selo').textContent, 'DEMONSTRAÇÃO');
    assert.equal(doc.querySelector('#t13 .rot').textContent, 'Próximo passo');
    assert.equal(doc.querySelector('#t13 h1.titulo').textContent, 'Três jeitos de seguir com o agente.');
    assert.deepEqual(trocas, [], search);
  }
});

test('com diagnóstico + motivo=limite: o modo real vence (t01 → t06 → t13, textos da t13 intactos)', () => {
  const doc = montarDoc();
  const { trocas } = carregar(doc, JSON.stringify(DIAG), '?motivo=limite');
  assert.ok(doc.documentElement.classList.contains('modo-real'));
  assert.equal(doc.documentElement.classList.contains('modo-limite'), false);
  assert.deepEqual(doc.querySelectorAll('section[data-estado]').map((s) => s.getAttribute('id')), ['t01', 't06', 't13']);
  assert.equal(doc.querySelector('#t01 .num').textContent, '4');
  assert.ok(doc.querySelector('#t13 .selo').hasAttribute('hidden'));
  assert.equal(doc.querySelector('#t13 .rot').textContent, 'Próximo passo');
  assert.equal(doc.querySelector('#t13 h1.titulo').textContent, 'Três jeitos de seguir com o agente.');
  assert.deepEqual(trocas, []);
});

test('querLimite: só motivo=limite exato liga o modo', () => {
  const { api } = carregar(montarDoc(), null);
  assert.equal(api.querLimite('?motivo=limite'), true);
  assert.equal(api.querLimite('?utm_source=a&motivo=limite#t13'.split('#')[0]), true);
  assert.equal(api.querLimite(''), false);
  assert.equal(api.querLimite('?motivo=limites'), false);
  assert.equal(api.querLimite('?xmotivo=limite'), false);
});

// ── index.html copiado para o repo ──
test('index.html do repo: diagnostico-real.js logo depois de </main> e antes de qualquer outro <script>; assinatura por caminho relativo; CSS .modo-real .lateral', () => {
  const posMain = html.indexOf('</main>');
  const primeiroScript = html.indexOf('<script', posMain);
  assert.ok(posMain > 0);
  assert.match(html.slice(primeiroScript, primeiroScript + 60), /^<script src="diagnostico-real\.js"><\/script>/);
  assert.equal(html.lastIndexOf('<script', posMain), -1, 'nenhum <script> antes de </main>');
  assert.match(html, /<script src="\.\.\/assinatura-medicao\.js"><\/script>\s*<script src="\.\.\/assinatura\.js"><\/script>/);
  assert.doesNotMatch(html, /\b(src|href)="\/repo\/agentes\/auditor\//, 'nenhum src/href absoluto para /repo/agentes/auditor/');
  assert.match(html, /\.modo-real \.lateral\s*\{\s*display:\s*none;?\s*\}/);
});

test('index.html do repo: todo href/src relativo resolve para um arquivo existente', () => {
  const refs = [...html.matchAll(/\b(?:href|src)="([^"#][^"]*)"/g)].map((m) => m[1]).filter((u) => !/^(https?:)?\/\//.test(u) && !u.startsWith('/'));
  assert.ok(refs.length >= 10, 'achou as referências');
  for (const r of refs) assert.ok(existsSync(resolve(pasta, r)), 'existe: ' + r);
});
