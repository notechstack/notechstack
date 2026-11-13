// Lucca, 13/11/2026 (v3): LP nova do nó.fiscal. (1) Uma seção por funcionalidade, com pouco texto, o aparelho sozinho e
// o selo do plano, sem título solto antes delas; (2) três cards de planos (a Agência saiu), com o PREÇO em evidência e,
// embaixo, o que cabe; (3) mensal ou anual (20% OFF) nos três; (4) Escritório com as faixas de 5, 20 e 50 empresas, o
// "50+" sob medida (WhatsApp) e a Black Friday (condição de fundador, cupons FUNDADOR5/20/50, só no mensal) até
// 30/11/2026, que some sozinha depois do prazo; (5) os valores batem com os do checkout (assinatura-fiscal/core.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { abrirPagina, HTML, ler, repo, texto } from './pagina-falsa.mjs';

const CORE = ler('supabase/functions/assinatura-fiscal/core.ts');
const SQL = ler('scripts/pagarme-assinatura/cupons-fundador-escritorio.sql');
const reais = (centavos) => 'R$ ' + (centavos / 100).toLocaleString('pt-BR', { minimumFractionDigits: centavos % 100 ? 2 : 0 }).replace(/ /g, ' ');
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
function botao(attrs, dataset = {}) {
  return {
    atributos: { ...attrs }, ouvintes: {}, dataset,
    getAttribute(k) { return k in this.atributos ? this.atributos[k] : null; },
    setAttribute(k, v) { this.atributos[k] = String(v); },
    addEventListener(t, f) { (this.ouvintes[t] = this.ouvintes[t] || []).push(f); },
    clicar() { for (const f of this.ouvintes.click || []) f({}); }
  };
}
function pagina(iso) {
  const faixas = ['escritorio_5', 'escritorio_20', 'escritorio_50', 'sob_medida'].map((f) => botao({ 'data-faixa': f }));
  const ciclos = { mensal: botao({}, { ciclo: 'mensal' }), anual: botao({}, { ciclo: 'anual' }) };
  const p = abrirPagina({
    seletores: { '[data-faixa]': faixas, '.fi-ciclo-toggle [data-ciclo]': [ciclos.mensal, ciclos.anual] },
    extras: { Date: relogio(iso) }
  });
  return { p, faixas, ciclos, cta: p.el('fi-esc-cta'), zap: p.el('fi-esc-zap') };
}
const palavras = (html) => texto(html).split(/\s+/).filter(Boolean).length;

test('funcionalidades: direto da hero, uma seção por recurso, curta, com o aparelho e o selo do plano', () => {
  const s = secao('como-funciona');
  // Lucca, 13/11/2026: sem o título "Tudo numa conversa" nem o subtítulo; fica um h2 só para leitor de tela.
  assert.doesNotMatch(HTML, /Tudo numa conversa/);
  assert.match(s, /^\s*<h2 class="fi-sr" id="fi-fxs-titulo">[^<]+<\/h2>\s*<article/);
  const fx = [...s.matchAll(/<article\b[^>]*class="fi-fx[^"]*"[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/article>/g)]
    .map((m) => ({ id: m[1], html: m[2], selo: texto((/class="fi-fx-chip[^"]*">([^<]*)/.exec(m[2]) || [])[1] || '') }));
  assert.deepEqual(fx.map((f) => f.id), ['fx-emitir', 'fx-corrigir', 'fx-cliente', 'fx-copias', 'fx-planilha', 'fx-empresas']);
  assert.deepEqual(fx.map((f) => f.selo), ['Todos os planos', 'Todos os planos', 'Todos os planos', 'A partir do Pro', 'Só no Escritório', 'Só no Escritório']);
  for (const f of fx) {
    const txt = /<div class="fi-fx-texto">([\s\S]*)<\/div>/.exec(f.html)[1];
    assert.match(txt, /<h3>[^<]+<\/h3>/, f.id + ': título');
    // "muito texto, maçante de ler": cada seção cabe em 45 palavras, com no máximo 3 pontos.
    assert.ok(palavras(txt) <= 45, `${f.id}: ${palavras(txt)} palavras`);
    assert.ok((txt.match(/<li>/g) || []).length <= 3, f.id + ': até 3 pontos');
  }
  // Os mockups em vídeo são mudos, sem autoplay no HTML (o fiscal.js toca na tela), com capa; os arquivos existem e são leves.
  const videos = [...HTML.matchAll(/<video\b([^>]*)>\s*<source src="([^"]+)"/g)];
  assert.equal(videos.length, 4);
  for (const [, attrs, src] of videos) {
    assert.match(attrs, /\bmuted\b/); assert.match(attrs, /\bplaysinline\b/); assert.match(attrs, /preload="none"/);
    assert.doesNotMatch(attrs, /\bautoplay\b/);
    assert.match(attrs, /aria-label="Demonstração: [^"]+"/);
    const capa = /poster="([^"]+)"/.exec(attrs)[1];
    for (const rota of [src, capa]) {
      const arq = resolve(repo, rota.slice(1));
      assert.ok(existsSync(arq), rota);
      assert.ok(statSync(arq).size < 4.5 * 1024 * 1024, rota + ' passa de 4,5 MB');
    }
  }
  assert.match(texto(s), /Telas de demonstração, com dados fictícios/);
  // A seção das cópias mostra de onde vem cada aviso (Gmail, WhatsApp) e o tipo de cada anexo (PDF, XML).
  const copias = fx.find((f) => f.id === 'fx-copias').html;
  assert.match(copias, /<svg[^>]*>[\s\S]*?<\/svg>Gmail/);
  assert.match(copias, /<svg[^>]*>[\s\S]*?<\/svg>WhatsApp/);
  assert.match(copias, /fi-arq--pdf"><i>PDF<\/i>/); assert.match(copias, /fi-arq--xml"><i>XML<\/i>/);
  // Várias empresas: mockup de celular em HTML (o vídeo do notebook era ilegível no celular), com os nomes do painel.
  const empresas = fx.find((f) => f.id === 'fx-empresas').html;
  assert.doesNotMatch(empresas, /<video/);
  assert.match(empresas, /class="fi-fone"/);
  for (const t of ['Minhas empresas', 'Pronta', 'Falta A1 ou procuração', 'Enviar A1', 'Procuração', 'Adicionar empresa']) assert.ok(texto(empresas).includes(t), t);
});

test('planos: três cards, preço em evidência, cada um soma ao anterior', () => {
  const s = secao('planos');
  const cards = [...s.matchAll(/<li class="fi-plano[^"]*" data-plano="(\w+)">([\s\S]*?)<\/ul>\s*<\/li>/g)].map((m) => ({ plano: m[1], html: m[2], txt: texto(m[2]) }));
  assert.deepEqual(cards.map((c) => c.plano), ['inicial', 'pro', 'escritorio'], 'a Agência saiu dos cards');
  const [inicial, pro, escritorio] = cards;
  for (const c of cards) {
    const itens = [...(/<ul class="fi-plano-itens">([\s\S]*)$/.exec(c.html)[1]).matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((m) => texto(m[1]));
    assert.ok(itens.length <= 4, c.plano + ': até 4 itens');
    for (const i of itens) assert.ok(i.split(/\s+/).length <= 6, `${c.plano}: "${i}" passa de 6 palavras`);
    // O preço vem primeiro e grande (fi-plano-valor); as notas vêm embaixo, em texto (fi-plano-cabe).
    const iValor = c.html.indexOf('class="fi-plano-valor"'), iCabe = c.html.indexOf('class="fi-plano-cabe"');
    assert.ok(iValor > 0 && iCabe > iValor, c.plano + ': preço antes do que cabe');
    assert.doesNotMatch(c.html, /fi-plano-gratis/, c.plano + ': o número de notas não é mais o destaque');
  }
  assert.match(pro.txt, /Tudo do Inicial, e mais:/);
  assert.match(escritorio.txt, /Tudo do Pro, e mais:/);
  assert.match(inicial.html, /<b data-mensal="R\$ 49" data-anual="R\$ 39,20">R\$ 49<\/b><span>\/mês<\/span><\/p>\s*<p class="fi-plano-cabe">20 notas por mês<\/p>/);
  assert.match(pro.html, /<b data-mensal="R\$ 129" data-anual="R\$ 103,20">R\$ 129<\/b><span>\/mês<\/span><\/p>\s*<p class="fi-plano-cabe">100 notas por mês<\/p>/);
  assert.match(pro.txt, /Cópia ao cliente e ao contador/);
  assert.match(escritorio.txt, /Planilha no WhatsApp/); assert.match(escritorio.txt, /A1 ou procuração/);
  // Todo link interno dos cards cai num id que existe na página.
  for (const c of cards) for (const [, alvo] of c.html.matchAll(/href="#([^"]+)"/g)) assert.match(HTML, new RegExp(`id="${alvo}"`), '#' + alvo);
  // Checkout no site nos três planos; o WhatsApp fica só no "sob medida" do Escritório (escondido até escolher 50+).
  assert.match(inicial.html, /href="\/agentes\/fiscal\/comecar\/\?plano=inicial"/);
  assert.match(pro.html, /href="\/agentes\/fiscal\/comecar\/\?plano=pro"/);
  assert.match(escritorio.html, /id="fi-esc-cta" data-plano="escritorio_5" href="\/agentes\/fiscal\/comecar\/\?tipo=escritorio&amp;plano=escritorio_5"/);
  assert.equal((s.match(/wa\.me/g) || []).length, 1);
  assert.match(escritorio.html, /id="fi-esc-zap" data-lead="escritorio" href="https:\/\/wa\.me\/5511939289413\?text=[^"]*50%20empresas[^"]*" target="_blank" rel="noopener noreferrer" hidden>Falar com a Nó/);
  assert.deepEqual([...escritorio.html.matchAll(/data-faixa="(\w+)">([^<]*)</g)].map((m) => m[1] + ':' + m[2]), ['escritorio_5:5', 'escritorio_20:20', 'escritorio_50:50', 'sob_medida:50+']);
  // O anual aparece grande no card: "20% OFF" nos três planos, e o preço cheio cortado.
  for (const c of [inicial, pro]) assert.match(c.html, /<span class="fi-off" data-so-anual>20% OFF<\/span>/, c.plano);
  assert.match(escritorio.html, /<span class="fi-off" id="fi-esc-off" data-so-anual>25% OFF<\/span>/);
  assert.match(inicial.html, /<s class="fi-preco-de" data-so-anual>R\$ 49<\/s>/);
  assert.match(pro.html, /<s class="fi-preco-de" data-so-anual>R\$ 129<\/s>/);
  assert.match(texto(s), /A nota é assinada com o certificado A1 da empresa ou, no Escritório, por procuração eletrônica/);
});

test('preços da página batem com o checkout, com o anual e com os cupons de fundador', () => {
  const js = ler('agentes/fiscal/fiscal.js');
  let maior = 0;
  for (const [faixa, cupom] of [['escritorio_5', 'FUNDADOR5'], ['escritorio_20', 'FUNDADOR20'], ['escritorio_50', 'FUNDADOR50']]) {
    const core = new RegExp(`${faixa}: \\{ centavos: (\\d+), empresas: (\\d+), notas: (\\d+) \\}`).exec(CORE);
    assert.ok(core, faixa + ' no core.ts');
    const cheio = Number(core[1]);
    const desconto = Number(new RegExp(`'${cupom}'[^\\n]*'valor', (\\d+), 12, array\\['${faixa}'\\], 30, 20`).exec(SQL)[1]);
    const linha = new RegExp(`${faixa}: \\{ notas: '([^']+)', empresas: '(\\d+)', cheio: '([^']+)', fundador: '([^']+)', off: '(\\d+)% OFF', cupom: '(\\w+)', anual: '([^']+)', ano: '([^']+)', offAnual: '(\\d+)% OFF' \\}`).exec(js);
    assert.ok(linha, faixa + ' no fiscal.js');
    assert.equal(linha[1], Number(core[3]).toLocaleString('pt-BR'), faixa + ': notas');
    assert.equal(linha[2], core[2], faixa + ': empresas');
    assert.equal(linha[3], reais(cheio), faixa + ': preço cheio');
    assert.equal(linha[4], reais(cheio - desconto), faixa + ': preço de fundador');
    // O selo da Black Friday diz o desconto de verdade da faixa, arredondado ao inteiro.
    assert.equal(Number(linha[5]), Math.round(desconto / cheio * 100), faixa + ': % do selo');
    maior = Math.max(maior, Number(linha[5]));
    assert.equal(linha[6], cupom);
    // Anual do Escritório: o desconto da faixa vem do checkout (DESCONTO_ANUAL_ESCRITORIO: 25%, 30% e 45%).
    const pct = Number(new RegExp(`${faixa}: (\\d+)`).exec(/DESCONTO_ANUAL_ESCRITORIO[^=]*= \{([^}]*)\}/.exec(CORE)[1])[1]);
    assert.equal(Number(linha[9]), pct, faixa + ': % do anual');
    assert.equal(linha[7], reais(Math.round(cheio * (100 - pct) / 100)), faixa + ': mês no anual');
    assert.equal(linha[8], reais(Math.round(cheio * 12 * (100 - pct) / 100)), faixa + ': total do ano');
  }
  assert.match(texto(secao('planos')), new RegExp(`até ${maior}% OFF no 1º ano`), 'a faixa da Black Friday promete o maior desconto que existe');
  // Inicial e Pro: o anual da página é o do checkout (centavosAnuais: 12 mensalidades com 20% off).
  assert.match(HTML, /data-anual=" · R\$ 470,40\/ano"/);
  assert.match(HTML, /data-anual=" · R\$ 1\.238,40\/ano"/);
  assert.equal(reais(4900 * 0.8 * 12), 'R$ 470,40');
  assert.equal(reais(12900 * 0.8 * 12), 'R$ 1.238,40');
  assert.match(SQL, /max_usos 20 em cada faixa/);
  assert.match(texto(secao('planos')), /20 vagas por faixa/);
});

test('Black Friday dentro do prazo, no mensal: selo com o desconto, preço cortado e cupom no link', () => {
  const { p, faixas, cta } = pagina('2026-11-20T12:00:00-03:00');
  assert.equal(p.el('fi-fundador').hidden, false);
  assert.equal(p.el('fi-planos').atributos['data-fundador'], 'on');
  assert.equal(p.el('fi-esc-ticket').hidden, false);
  assert.equal(p.el('fi-esc-ticket-off').textContent, '17% OFF');
  assert.equal(p.el('fi-esc-de').hidden, false);
  assert.equal(p.el('fi-esc-de').textContent, 'R$ 297');
  assert.equal(p.el('fi-esc-valor').textContent, 'R$ 247');
  assert.equal(p.el('fi-esc-cabe').textContent, '500 notas por mês');
  assert.match(p.el('fi-esc-depois').innerHTML, /1º mês grátis/);
  assert.equal(cta.textContent, 'Testar 1 mês grátis');
  assert.equal(cta.atributos.href, '/agentes/fiscal/comecar/?tipo=escritorio&plano=escritorio_5&cupom=FUNDADOR5');
  faixas[1].clicar();
  assert.equal(p.el('fi-esc-ticket-off').textContent, '19% OFF');
  assert.equal(p.el('fi-esc-cabe').textContent, '2.000 notas por mês');
  assert.equal(p.el('fi-esc-valor').textContent, 'R$ 647');
  assert.equal(cta.atributos['data-plano'], 'escritorio_20');
  assert.equal(cta.atributos.href, '/agentes/fiscal/comecar/?tipo=escritorio&plano=escritorio_20&cupom=FUNDADOR20');
  assert.deepEqual(faixas.map((b) => b.atributos['aria-pressed']), ['false', 'true', 'false', 'false']);
  faixas[2].clicar();
  assert.equal(p.el('fi-esc-ticket-off').textContent, '20% OFF');
  assert.equal(p.el('fi-esc-valor').textContent, 'R$ 1.197');
});

test('Escritório 50+: sob medida, sem preço, e o botão vai ao WhatsApp', () => {
  for (const iso of ['2026-11-20T12:00:00-03:00', '2027-01-15T10:00:00-03:00']) {
    const { p, faixas, ciclos, cta, zap } = pagina(iso);
    assert.equal(zap.hidden, true);
    faixas[3].clicar();
    assert.equal(p.el('fi-esc-valor').textContent, 'Sob medida');
    assert.equal(p.el('fi-esc-por').hidden, true, 'sem "/mês"');
    assert.equal(p.el('fi-esc-de').hidden, true);
    assert.equal(p.el('fi-esc-ticket').hidden, true);
    assert.equal(p.el('fi-esc-off').hidden, true);
    assert.match(p.el('fi-esc-depois').innerHTML, /Mais de 50 empresas/);
    assert.equal(cta.hidden, true);
    assert.equal(zap.hidden, false);
    // trocar o ciclo não devolve preço ao sob medida; voltar a uma faixa devolve o cadastro
    ciclos.anual.clicar();
    assert.equal(p.el('fi-esc-valor').textContent, 'Sob medida');
    assert.equal(zap.hidden, false);
    faixas[0].clicar();
    assert.equal(cta.hidden, false);
    assert.equal(zap.hidden, true);
    assert.equal(p.el('fi-esc-por').hidden, false);
    assert.equal(p.el('fi-esc-valor').textContent, 'R$ 222,75');
  }
});

test('Escritório no anual: 25%, 30% e 45% OFF por faixa, sem o cupom de fundador', () => {
  for (const iso of ['2026-11-20T12:00:00-03:00', '2027-01-15T10:00:00-03:00']) {
    const { p, faixas, ciclos, cta } = pagina(iso);
    ciclos.anual.clicar();
    assert.equal(p.el('fi-planos').atributos['data-ciclo'], 'anual');
    assert.equal(p.el('fi-esc-ticket').hidden, true, 'a Black Friday é só do mensal');
    assert.equal(p.el('fi-esc-de').hidden, false);
    assert.equal(p.el('fi-esc-de').textContent, 'R$ 297');
    assert.equal(p.el('fi-esc-valor').textContent, 'R$ 222,75');
    assert.equal(p.el('fi-esc-off').textContent, '25% OFF');
    assert.match(p.el('fi-esc-depois').innerHTML, /7 dias grátis<\/b> · R\$ 2\.673\/ano/);
    assert.equal(cta.atributos.href, '/agentes/fiscal/comecar/?tipo=escritorio&plano=escritorio_5&ciclo=anual');
    faixas[1].clicar();
    assert.equal(p.el('fi-esc-valor').textContent, 'R$ 557,90');
    assert.equal(p.el('fi-esc-off').textContent, '30% OFF');
    assert.equal(cta.atributos.href, '/agentes/fiscal/comecar/?tipo=escritorio&plano=escritorio_20&ciclo=anual');
    faixas[2].clicar();
    assert.equal(p.el('fi-esc-valor').textContent, 'R$ 823,35');
    assert.equal(p.el('fi-esc-off').textContent, '45% OFF');
    assert.match(p.el('fi-esc-depois').innerHTML, /R\$ 9\.880,20\/ano/);
    // de volta ao mensal, a faixa escolhida fica
    ciclos.mensal.clicar();
    assert.equal(cta.atributos['data-plano'], 'escritorio_50');
    assert.doesNotMatch(cta.atributos.href, /ciclo=anual/);
  }
});

test('depois de 30/11: a Black Friday some e fica o preço cheio, com 7 dias', () => {
  for (const iso of ['2026-12-01T00:00:00-03:00', '2027-01-15T10:00:00-03:00']) {
    const { p, faixas, cta } = pagina(iso);
    assert.equal(p.el('fi-fundador').hidden, true, iso);
    assert.equal(p.el('fi-planos').atributos['data-fundador'], 'off');
    assert.equal(p.el('fi-esc-ticket').hidden, true);
    assert.equal(p.el('fi-esc-de').hidden, true);
    assert.equal(p.el('fi-esc-valor').textContent, 'R$ 297');
    assert.match(p.el('fi-esc-depois').innerHTML, /^<b>7 dias grátis<\/b>$/);
    assert.equal(cta.textContent, 'Testar 7 dias grátis');
    assert.equal(cta.atributos.href, '/agentes/fiscal/comecar/?tipo=escritorio&plano=escritorio_5');
    faixas[2].clicar();
    assert.equal(p.el('fi-esc-valor').textContent, 'R$ 1.497');
    assert.doesNotMatch(cta.atributos.href, /cupom/);
  }
  // 30/11 às 23:59 de Brasília ainda vale.
  assert.equal(pagina('2026-11-30T23:59:00-03:00').p.el('fi-fundador').hidden, false);
});

test('sem JS a página não anuncia a Black Friday: faixa e selo escondidos, preço cheio no HTML', () => {
  assert.match(HTML, /<div class="fi-fundador" id="fi-fundador" hidden>/);
  assert.match(HTML, /<span class="fi-plano-ticket" id="fi-esc-ticket" hidden>/);
  assert.match(HTML, /<s class="fi-preco-de" id="fi-esc-de" hidden>R\$ 297<\/s><b id="fi-esc-valor">R\$ 297<\/b>/);
  assert.match(HTML, /id="fi-planos" data-ciclo="mensal" data-fundador="off"/);
  const css = ler('agentes/fiscal/fiscal.css');
  assert.match(css, /\.fi-planos\[data-ciclo="mensal"\] \[data-so-anual\]\{display:none\}/);
  assert.doesNotMatch(css, /data-ciclo="anual"\] \[data-plano="escritorio"\]/, 'o Escritório não some mais no anual');
});

test('FAQ: planilha, várias empresas e mais de 50 empresas; a Agência saiu', () => {
  const faq = new Map([...HTML.matchAll(/<details\b[^>]*>\s*<summary\b[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g)].map((m) => [texto(m[1]), texto(m[2])]));
  assert.match(faq.get('Como emito várias notas de uma vez?'), /planilha \(\.xlsx ou \.csv\) no WhatsApp[\s\S]*até 1\.000 linhas/);
  assert.match(faq.get('Posso ter várias empresas na mesma conta?'), /até 5, 20 ou 50 empresas[\s\S]*procuração eletrônica/);
  assert.match(faq.get('Tenho mais de 50 empresas ou quero integrar por API. Como faço?'), /sob medida[\s\S]*WhatsApp/);
  assert.match(faq.get('Como funciona a procuração eletrônica?'), /Portal de Serviços da Receita Federal/);
  assert.ok(!faq.has('Qual a diferença entre Escritório e Agência?'));
});
