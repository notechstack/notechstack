// Lucca, 13/11/2026: LP nova do nó.fiscal. (1) Uma seção por funcionalidade, com o mockup do tutorial e o selo do
// plano; (2) cada card de plano soma recursos ao anterior e aponta para a seção do recurso; (3) Escritório com as três
// faixas e a condição de fundador (cupons FUNDADOR5/20/50) até 30/11/2026, que some sozinha depois do prazo;
// (4) os valores batem com os do checkout (supabase/functions/assinatura-fiscal/core.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { abrirPagina, HTML, ler, repo, texto } from './pagina-falsa.mjs';

const CORE = ler('supabase/functions/assinatura-fiscal/core.ts');
const SQL = ler('scripts/pagarme-assinatura/cupons-fundador-escritorio.sql');
const reais = (centavos) => 'R$ ' + (centavos / 100).toLocaleString('pt-BR').replace(/ /g, ' ');
const secao = (id) => {
  const m = new RegExp(`<section\\b[^>]*id="${id}"[^>]*>([\\s\\S]*?)</section>`).exec(HTML);
  assert.ok(m, 'seção #' + id);
  return m[1];
};
// Relógio fixo dentro da página: Date.now() e new Date() respondem `iso`; Date.parse segue o de verdade.
function relogio(iso) {
  const agora = Date.parse(iso);
  return class extends Date {
    constructor(...a) { if (a.length) super(...a); else super(agora); }
    static now() { return agora; }
  };
}
function botao(attrs) {
  return {
    atributos: { ...attrs }, ouvintes: {},
    getAttribute(k) { return k in this.atributos ? this.atributos[k] : null; },
    setAttribute(k, v) { this.atributos[k] = String(v); },
    addEventListener(t, f) { (this.ouvintes[t] = this.ouvintes[t] || []).push(f); },
    clicar() { for (const f of this.ouvintes.click || []) f({}); }
  };
}
function pagina(iso) {
  const faixas = ['escritorio_5', 'escritorio_20', 'escritorio_50'].map((f) => botao({ 'data-faixa': f }));
  const p = abrirPagina({ seletores: { '[data-faixa]': faixas }, extras: { Date: relogio(iso) } });
  return { p, faixas, cta: p.el('fi-esc-cta') };
}

test('funcionalidades: uma seção por recurso, com mockup e selo do plano', () => {
  const fx = [...secao('como-funciona').matchAll(/<article\b[^>]*class="fi-fx[^"]*"[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/article>/g)]
    .map((m) => ({ id: m[1], html: m[2], selo: texto((/class="fi-fx-chip[^"]*">([^<]*)/.exec(m[2]) || [])[1] || '') }));
  assert.deepEqual(fx.map((f) => f.id), ['fx-emitir', 'fx-corrigir', 'fx-cliente', 'fx-copias', 'fx-planilha', 'fx-empresas']);
  assert.deepEqual(fx.map((f) => f.selo), ['Todos os planos', 'Todos os planos', 'Todos os planos', 'A partir do Pro', 'Só no Escritório', 'Só no Escritório']);
  for (const f of fx) {
    assert.match(f.html, /<h3>[^<]+<\/h3>/, f.id + ': título');
    assert.ok((f.html.match(/<li>/g) || []).length >= 2, f.id + ': explica o que acontece');
  }
  // Os mockups são vídeos mudos, sem autoplay no HTML (o fiscal.js toca na tela), com capa; os arquivos existem e são leves.
  const videos = [...HTML.matchAll(/<video\b([^>]*)>\s*<source src="([^"]+)"/g)];
  assert.equal(videos.length, 5);
  for (const [, attrs, src] of videos) {
    assert.match(attrs, /\bmuted\b/); assert.match(attrs, /\bplaysinline\b/); assert.match(attrs, /preload="none"/);
    assert.doesNotMatch(attrs, /\bautoplay\b/);
    assert.match(attrs, /aria-label="Demonstração: [^"]+"/);
    const capa = /poster="([^"]+)"/.exec(attrs)[1];
    for (const rota of [src, capa]) {
      const arq = resolve(repo, rota.slice(1));
      assert.ok(existsSync(arq), rota);
      assert.ok(statSync(arq).size < 3.5 * 1024 * 1024, rota + ' passa de 3,5 MB');
    }
  }
  assert.match(texto(secao('como-funciona')), /demonstrações, com dados fictícios/);
});

test('planos: cada card soma ao anterior e aponta para a seção do recurso', () => {
  const s = secao('planos');
  const cards = [...s.matchAll(/<li class="fi-plano[^"]*" data-plano="(\w+)">([\s\S]*?)<\/ul>\s*<\/li>/g)].map((m) => ({ plano: m[1], html: m[2], txt: texto(m[2]) }));
  assert.deepEqual(cards.map((c) => c.plano), ['inicial', 'pro', 'escritorio', 'agencia']);
  const [inicial, pro, escritorio, agencia] = cards;
  assert.match(pro.txt, /Tudo do Inicial, e mais:/);
  assert.match(escritorio.txt, /Tudo do Pro, e mais:/);
  assert.match(inicial.txt, /20 notas\/mês/); assert.match(inicial.txt, /R\$ 49(?![\d,])/);
  assert.match(pro.txt, /100 notas\/mês/); assert.match(pro.txt, /R\$ 129(?![\d,])/);
  assert.match(pro.txt, /Cópia automática para o cliente e o contador/);
  assert.match(escritorio.txt, /Planilha no WhatsApp/); assert.match(escritorio.txt, /procuração eletrônica/);
  assert.match(agencia.txt, /Sob medida/);
  // Todo link interno dos cards cai num id que existe na página.
  for (const c of cards) for (const [, alvo] of c.html.matchAll(/href="#([^"]+)"/g)) assert.match(HTML, new RegExp(`id="${alvo}"`), '#' + alvo);
  // Checkout no site: Inicial, Pro e Escritório vão ao cadastro; só a Agência vai ao WhatsApp.
  assert.match(inicial.html, /href="\/agentes\/fiscal\/comecar\/\?plano=inicial"/);
  assert.match(pro.html, /href="\/agentes\/fiscal\/comecar\/\?plano=pro"/);
  assert.match(escritorio.html, /href="\/agentes\/fiscal\/comecar\/\?tipo=escritorio&amp;plano=escritorio_5"/);
  assert.equal((s.match(/wa\.me/g) || []).length, 1);
  assert.match(agencia.html, /wa\.me\/5511939289413/);
  // A assinatura: A1 ou, no Escritório, procuração.
  assert.match(texto(s), /Como a nota é assinada: com o certificado digital A1 da empresa/);
  assert.match(texto(s), /procuração eletrônica ao escritório, sem A1 próprio/);
});

test('preços da página batem com o checkout e com os cupons de fundador', () => {
  const js = ler('agentes/fiscal/fiscal.js');
  for (const [faixa, cupom] of [['escritorio_5', 'FUNDADOR5'], ['escritorio_20', 'FUNDADOR20'], ['escritorio_50', 'FUNDADOR50']]) {
    const core = new RegExp(`${faixa}: \\{ centavos: (\\d+), empresas: (\\d+), notas: (\\d+) \\}`).exec(CORE);
    assert.ok(core, faixa + ' no core.ts');
    const desconto = Number(new RegExp(`'${cupom}'[^\\n]*'valor', (\\d+), 12, array\\['${faixa}'\\], 30, 20`).exec(SQL)[1]);
    const linha = new RegExp(`${faixa}: \\{ notas: '([^']+)', cheio: '([^']+)', fundador: '([^']+)', cupom: '(\\w+)' \\}`).exec(js);
    assert.ok(linha, faixa + ' no fiscal.js');
    assert.equal(linha[1], Number(core[3]).toLocaleString('pt-BR'), faixa + ': notas');
    assert.equal(linha[2], reais(Number(core[1])), faixa + ': preço cheio');
    assert.equal(linha[3], reais(Number(core[1]) - desconto), faixa + ': preço de fundador');
    assert.equal(linha[4], cupom);
  }
  assert.match(SQL, /max_usos 20 em cada faixa/);
  assert.match(texto(secao('planos')), /20 vagas por faixa/);
});

test('fundador dentro do prazo: preço cortado, 1º mês grátis e cupom no link', () => {
  const { p, faixas, cta } = pagina('2026-11-20T12:00:00-03:00');
  assert.equal(p.el('fi-fundador').hidden, false);
  assert.equal(p.el('fi-planos').atributos['data-fundador'], 'on');
  assert.equal(p.el('fi-esc-de').textContent, 'R$ 297');
  assert.equal(p.el('fi-esc-valor').textContent, 'R$ 247');
  assert.match(p.el('fi-esc-nota').textContent, /no 1º ano, com o cupom FUNDADOR5 já aplicado; depois, R\$ 297/);
  assert.match(p.el('fi-esc-depois').innerHTML, /1º mês grátis/);
  assert.equal(cta.atributos.href, '/agentes/fiscal/comecar/?tipo=escritorio&plano=escritorio_5&cupom=FUNDADOR5');
  faixas[1].clicar();
  assert.equal(p.el('fi-esc-notas').textContent, '2.000');
  assert.equal(p.el('fi-esc-valor').textContent, 'R$ 647');
  assert.equal(cta.atributos['data-plano'], 'escritorio_20');
  assert.equal(cta.atributos.href, '/agentes/fiscal/comecar/?tipo=escritorio&plano=escritorio_20&cupom=FUNDADOR20');
  assert.deepEqual(faixas.map((b) => b.atributos['aria-pressed']), ['false', 'true', 'false']);
  faixas[2].clicar();
  assert.equal(p.el('fi-esc-valor').textContent, 'R$ 1.197');
  assert.equal(p.el('fi-esc-notas').textContent, '5.000');
});

test('fundador depois de 30/11: a oferta some e fica o preço cheio, com 7 dias', () => {
  for (const iso of ['2026-12-01T00:00:00-03:00', '2027-01-15T10:00:00-03:00']) {
    const { p, faixas, cta } = pagina(iso);
    assert.equal(p.el('fi-fundador').hidden, true, iso);
    assert.equal(p.el('fi-planos').atributos['data-fundador'], 'off');
    assert.equal(p.el('fi-esc-valor').textContent, 'R$ 297');
    assert.equal(p.el('fi-esc-nota').textContent, '');
    assert.match(p.el('fi-esc-depois').innerHTML, /7 dias grátis/);
    assert.equal(cta.textContent, 'Testar 7 dias grátis');
    assert.equal(cta.atributos.href, '/agentes/fiscal/comecar/?tipo=escritorio&plano=escritorio_5');
    faixas[2].clicar();
    assert.equal(p.el('fi-esc-valor').textContent, 'R$ 1.497');
    assert.doesNotMatch(cta.atributos.href, /cupom/);
  }
  // 30/11 às 23:59 de Brasília ainda vale.
  assert.equal(pagina('2026-11-30T23:59:00-03:00').p.el('fi-fundador').hidden, false);
});

test('sem JS a página não anuncia o fundador: faixa escondida e preço cheio no HTML', () => {
  assert.match(HTML, /<div class="fi-fundador" id="fi-fundador" hidden>/);
  assert.match(HTML, /id="fi-planos" data-ciclo="mensal" data-fundador="off"/);
  assert.match(HTML, /<b id="fi-esc-valor">R\$ 297<\/b>/);
  const css = ler('agentes/fiscal/fiscal.css');
  assert.match(css, /\.fi-planos\[data-fundador="off"\] \[data-so-fundador\]\{display:none\}/);
  assert.match(css, /\.fi-planos\[data-ciclo="mensal"\] \[data-so-anual\]/);
});
