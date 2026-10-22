// Página falsa da LP do agente fiscal: roda os scripts inline do index.html e o fiscal.js de verdade num DOM
// mínimo em node:vm (precedente: tests/assinatura-auditor/lp-retrospectiva.test.mjs). Os elementos com id saem do
// próprio index.html (se o id não está lá, getElementById devolve null), e toda API de rede fica grampeada.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ler = (rel) => readFileSync(resolve(repo, rel), 'utf8');
export const HTML = ler('agentes/fiscal/index.html');
export const JS = ler('agentes/fiscal/fiscal.js');
export const MEDICAO = ler('agentes/fiscal/medicao.js');

export const PRONTIA = 'quero emitir uma nota pra Prontia Saúde no valor de 10 reais, use os modelos da Prontia';

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
// Texto visível de um trecho de HTML: sem tags, entidades decodificadas, espaços (inclusive o não separável) colapsados.
export function texto(html) {
  return String(html).replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&(lt|gt|quot|#39|nbsp|amp);/g, (_, e) => ENT[e])
    .replace(/\s+/g, ' ').trim(); // \s inclui o espaço não separável que o toLocaleString põe em "R$ 10,00"
}

export function scriptsInline(html = HTML) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(([, attrs]) => !/\bsrc=/.test(attrs) && !/ld\+json/.test(attrs))
    .map(([, , corpo]) => corpo);
}

export async function esvaziar() { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); }

function lista() {
  const s = new Set();
  return {
    add: (...c) => c.forEach((x) => s.add(x)), remove: (...c) => c.forEach((x) => s.delete(x)), contains: (c) => s.has(c),
    toggle(c, forcar) { const on = forcar === undefined ? !s.has(c) : !!forcar; if (on) s.add(c); else s.delete(c); return on; }
  };
}

// querySelectorAll dentro de um balão do chat, lido do innerHTML. Só os seletores que a página usa; outro seletor
// derruba o teste, para o DOM falso nunca responder "nada" por omissão.
function buscar(el, sel) {
  const html = el.innerHTML;
  if (sel === 'button') {
    return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attrs, corpo]) => {
      const b = no('button');
      b.disabled = /\sdisabled\b/.test(attrs);
      const acao = /data-acao="([^"]*)"/.exec(attrs);
      if (acao) b.dataset.acao = acao[1];
      b.textContent = texto(corpo);
      b.closest = (s) => (/^button\b/.test(s) ? b : null);
      return b;
    });
  }
  // O ciclo "Simples assim" é só visual (conferido no navegador): aqui ele fica sem passos e não roda.
  if (sel === '.fi-roda-no') return [];
  const m = /^\.([\w-]+) li$/.exec(sel);
  if (m) {
    const bloco = new RegExp(`<(\\w+)[^>]*class="[^"]*\\b${m[1]}\\b[^"]*"[^>]*>([\\s\\S]*?)</\\1>`).exec(html);
    return bloco ? [...bloco[2].matchAll(/<li\b[^>]*>[\s\S]*?<\/li>/g)].map(() => no('li')) : [];
  }
  throw new Error('seletor não suportado no DOM falso: ' + sel);
}

function no(tag, reg) {
  return {
    tagName: String(tag).toUpperCase(), hidden: false, disabled: false, value: '', textContent: '', className: '',
    dataset: {}, style: { setProperty() {} }, classList: lista(), filhos: [], ouvintes: {}, scrollTop: 0, scrollHeight: 0,
    pai: null, _html: '', _cache: {},
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); this._cache = {}; if (reg) reg.html.push(this._html); },
    addEventListener(t, f) { (this.ouvintes[t] = this.ouvintes[t] || []).push(f); },
    disparar(t, ev) { for (const f of this.ouvintes[t] || []) f(ev); },
    appendChild(c) { c.pai = this; this.filhos.push(c); return c; },
    remove() { if (this.pai) this.pai.filhos = this.pai.filhos.filter((x) => x !== this); this.pai = null; },
    querySelectorAll(sel) { return this._cache[sel] || (this._cache[sel] = buscar(this, sel)); },
    closest() { return null; }, focus() {}, scrollIntoView() {}, setAttribute() {}, removeAttribute() {}
  };
}

// Elemento com o estado inicial que o index.html declara: atributo hidden e texto, quando é uma folha.
function doHtml(id, reg) {
  const m = new RegExp(`<(\\w+)\\b([^>]*\\sid="${id}"[^>]*)>`).exec(HTML);
  if (!m) return null;
  const el = no(m[1], reg);
  el.hidden = /\shidden(?=[\s>=]|$)/.test(m[2]);
  const folha = new RegExp(`^([^<]*)</${m[1]}>`).exec(HTML.slice(m.index + m[0].length));
  if (folha) el.textContent = texto(folha[1]);
  return el;
}

// Abre a página: mesmo `armazenamento` entre duas chamadas = recarregar no mesmo navegador.
export function abrirPagina({ armazenamento = new Map() } = {}) {
  const reg = { rede: [], criados: [], html: [], navegou: [] };
  const ids = {};
  const document = {
    cookie: '', activeElement: null, documentElement: { classList: lista() },
    getElementById(id) { if (!(id in ids)) ids[id] = doHtml(id, reg); return ids[id]; },
    querySelectorAll: () => [], getElementsByTagName: () => [],
    createElement(tag) { reg.criados.push(String(tag).toLowerCase()); return no(tag, reg); },
    addEventListener() {}
  };
  const grampo = (nome) => function () { reg.rede.push(nome); throw new Error(nome + ' bloqueado no teste'); };
  const ctx = {
    console, URL, URLSearchParams,
    setTimeout: (f) => { f(); return 0; }, clearTimeout() {},
    matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    localStorage: {
      getItem: (k) => (armazenamento.has(k) ? armazenamento.get(k) : null),
      setItem: (k, v) => { armazenamento.set(k, String(v)); },
      removeItem: (k) => { armazenamento.delete(k); }
    },
    location: {
      hostname: 'www.notechstack.com.br', origin: 'https://www.notechstack.com.br', pathname: '/agentes/fiscal/', search: '',
      href: 'https://www.notechstack.com.br/agentes/fiscal/', assign: (u) => { reg.navegou.push(u); }
    },
    navigator: { sendBeacon: grampo('navigator.sendBeacon') },
    fetch: grampo('fetch'), XMLHttpRequest: grampo('XMLHttpRequest'), WebSocket: grampo('WebSocket'),
    EventSource: grampo('EventSource'), Image: grampo('Image'),
    addEventListener() {},
    document
  };
  ctx.window = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  for (const s of scriptsInline()) vm.runInContext(s, ctx);
  vm.runInContext(MEDICAO, ctx);
  vm.runInContext(JS, ctx);

  const el = (id) => document.getElementById(id);
  const chat = el('fi-chat');
  const pagina = {
    ctx, reg, armazenamento, el,
    dataLayer: () => ctx.dataLayer || [],
    mensagens: () => (chat ? chat.filhos : []).map((m) => ({ el: m, classe: m.className, html: m.innerHTML, texto: texto(m.innerHTML) })),
    async enviar(t) {
      el('fi-input').value = t;
      el('fi-form').disparar('submit', { preventDefault() {} });
      await esvaziar();
    },
    // Clica no botão habilitado com esse rótulo, no balão mais recente que o tiver.
    async clicar(rotulo) {
      for (const m of [...(chat ? chat.filhos : [])].reverse()) {
        const b = m.querySelectorAll('button').find((x) => x.textContent === rotulo && !x.disabled);
        if (b) { m.disparar('click', { target: b }); await esvaziar(); return; }
      }
      throw new Error(`botão "${rotulo}" não está na conversa`);
    },
    botoes: () => pagina.mensagens().flatMap((m) => m.el.querySelectorAll('button').map((b) => b.textContent)),
    async emitirProntia() { await pagina.enviar(PRONTIA); await pagina.clicar('Confirmar emissão'); }
  };
  return pagina;
}

// Pares <dt>/<dd> de um balão (a nota), como texto visível.
export function campos(html) {
  return Object.fromEntries([...html.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/g)]
    .map(([, k, v]) => [texto(k), texto(v)]));
}
