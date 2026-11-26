// Lucca, 13/11/2026 (v3): LP nova do nó.fiscal. (1) Uma seção por funcionalidade, com pouco texto, o aparelho sozinho e
// o selo do plano, sem título solto antes delas; (2) três cards de planos (a Agência saiu), com o PREÇO em evidência e,
// embaixo, o que cabe; (3) mensal ou anual (20% OFF) nos três; (4) Escritório com as faixas de 5, 20 e 50 empresas, o
// "50+" sob medida (WhatsApp) e a Black Friday (condição de fundador, cupons FUNDADOR5/20/50, só no mensal) até
// 30/11/2026, que some sozinha depois do prazo; (5) os valores batem com os do checkout (assinatura-fiscal/core.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
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

// ── Planos por volume e módulos (Lucca, 23/11/2026) ──────────────────────────────────────────────────────────────────
// O Escritório vende documentos por mês (500, 1.000, 2.000, 5.000 e 10.000; "+10 mil" sob medida), com empresas
// ilimitadas, e o cliente marca o que emite (NFS-e, NF-e e Guias). A conta do preço fica em precos.js, a mesma da LP e
// do cadastro, e tem de bater com o que o servidor cobra (assinatura-fiscal/core.ts). O comportamento dos cards no
// navegador (caixas, ciclo, cupom no link) é conferido em tests/agente-fiscal-site/lp-planos.test.mjs, com DOM de verdade.
const P = (() => {
  const w = {};
  vm.runInNewContext(ler('agentes/fiscal/precos.js'), { window: w });
  return w.noFiscalPrecos;
})();
const MIGRACAO = ler('supabase/migrations/20261123210000_agente_fiscal_planos_volume.sql');

test('planos: três cards, preço em evidência, cada um soma ao anterior', () => {
  const s = secao('planos');
  const cards = [...s.matchAll(/<li class="fi-plano[^"]*" data-plano="(\w+)">([\s\S]*?)<\/ul>\s*<\/li>/g)].map((m) => ({ plano: m[1], html: m[2], txt: texto(m[2]) }));
  assert.deepEqual(cards.map((c) => c.plano), ['inicial', 'pro', 'escritorio'], 'a Agência saiu dos cards');
  const [inicial, pro, escritorio] = cards;
  for (const c of cards) {
    const itens = [...(/<ul class="fi-plano-itens">([\s\S]*)$/.exec(c.html)[1]).matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((m) => texto(m[1]));
    assert.ok(itens.length <= 4, c.plano + ': até 4 itens');
    for (const i of itens) assert.ok(i.split(/\s+/).length <= 6, `${c.plano}: "${i}" passa de 6 palavras`);
    // O preço vem primeiro e grande (fi-plano-valor); o que cabe vem embaixo, em texto (fi-plano-cabe).
    const iValor = c.html.indexOf('class="fi-plano-valor"'), iCabe = c.html.indexOf('class="fi-plano-cabe"');
    assert.ok(iValor > 0 && iCabe > iValor, c.plano + ': preço antes do que cabe');
  }
  assert.match(pro.txt, /Tudo do Inicial, e mais:/);
  assert.match(escritorio.txt, /Tudo do Pro, e mais:/);
  // Sem JS o card mostra o preço cheio do mês.
  assert.match(inicial.html, /<b data-valor>R\$ 49<\/b><span>\/mês<\/span>[\s\S]*<p class="fi-plano-cabe" data-cabe>20 notas por mês<\/p>/);
  assert.match(pro.html, /<b data-valor>R\$ 129<\/b><span>\/mês<\/span>[\s\S]*<p class="fi-plano-cabe" data-cabe>100 notas por mês<\/p>/);
  assert.match(escritorio.html, /<b data-valor>R\$ 297<\/b>[\s\S]*<p class="fi-plano-cabe" data-cabe>500 documentos por mês<\/p>/);
  // Inicial e Pro emitem NFS-e (está na lista do plano) e não têm caixas de módulo: a NF-e é do Escritório.
  assert.match(inicial.txt, /Emissão de NFS-e pelo WhatsApp/);
  for (const c of [inicial, pro]) assert.doesNotMatch(c.html, /fi-modulos/, c.plano);
  assert.match(escritorio.txt, /Empresas ilimitadas/);
  assert.match(escritorio.txt, /Planilha no WhatsApp/); assert.match(escritorio.txt, /A1 ou procuração/);
  // Todo link interno dos cards cai num id que existe na página.
  for (const c of cards) for (const [, alvo] of c.html.matchAll(/href="#([^"]+)"/g)) assert.match(HTML, new RegExp(`id="${alvo}"`), '#' + alvo);
  // Checkout no site nos três planos; o WhatsApp fica só no "sob medida" do Escritório (escondido até escolher +10 mil).
  assert.match(inicial.html, /href="\/agentes\/fiscal\/comecar\/\?plano=inicial"/);
  assert.match(pro.html, /href="\/agentes\/fiscal\/comecar\/\?plano=pro"/);
  assert.match(escritorio.html, /id="fi-esc-cta" data-plano="escritorio_5" href="\/agentes\/fiscal\/comecar\/\?tipo=escritorio&amp;plano=escritorio_5"/);
  assert.equal((s.match(/wa\.me/g) || []).length, 1);
  assert.match(escritorio.html, /id="fi-esc-zap" data-lead="escritorio" href="https:\/\/wa\.me\/5511939289413\?text=[^"]*10%20mil%20documentos[^"]*" target="_blank" rel="noopener noreferrer" hidden>Falar com a Nó/);
});

test('Escritório: seis opções de volume com os códigos do servidor e três caixas do que emite, sem "incluída"', () => {
  const s = secao('planos');
  assert.deepEqual([...s.matchAll(/data-faixa="(\w+)">([^<]*)</g)].map((m) => m[1] + ':' + m[2]),
    ['escritorio_5:500', 'escritorio_1000:1 mil', 'escritorio_20:2 mil', 'escritorio_50:5 mil', 'escritorio_10000:10 mil', 'sob_medida:+10 mil']);
  assert.deepEqual([...P.ORDEM], ['escritorio_5', 'escritorio_1000', 'escritorio_20', 'escritorio_50', 'escritorio_10000']);
  const caixas = [...s.matchAll(/<label><input type="checkbox" value="(\w+)"( checked)?><span>([^<]+)<\/span><small data-tag="\w+">([^<]*)<\/small><\/label>/g)].map((m) => [m[1], Boolean(m[2]), m[3], m[4]]);
  assert.deepEqual(caixas, [['nfse', true, 'NFS-e', ''], ['nfe', false, 'NF-e', '+R$ 197'], ['guias', false, 'Guias', '+R$ 197']]);
  assert.doesNotMatch(texto(s), /incluída/i, 'o tipo que vem no plano fica sem rótulo (Lucca, 23/11/2026)');
});

test('preços da página batem com o checkout: faixas, anual, segundo tipo de nota, Guias e cupons de fundador', async () => {
  const core = await import('../../supabase/functions/assinatura-fiscal/core.ts');
  assert.deepEqual(Object.keys(P.FAIXAS).sort(), Object.keys(core.FAIXAS_ESCRITORIO).sort());
  assert.equal(P.MODULO, core.MODULO_SEGUNDA_NOTA);
  assert.equal(P.MODULO, core.MODULO_GUIAS);
  assert.equal(P.MODULOS_JUNTOS, core.MODULOS_JUNTOS);
  for (const [faixa, f] of Object.entries(P.FAIXAS)) {
    const s = core.FAIXAS_ESCRITORIO[faixa];
    assert.equal(f.centavos, s.centavos, faixa);
    assert.equal(f.notas, s.notas, faixa);
    assert.equal(f.off, core.DESCONTO_ANUAL_ESCRITORIO[faixa], faixa);
    for (const notas of [['nfse'], ['nfe'], ['nfse', 'nfe']]) {
      const duas = notas.length === 2;
      // O que a assinatura principal cobra: o mesmo número do servidor, no mês e no ano.
      assert.equal(P.calcular(faixa, { notas }).total, core.centavosDoCiclo(faixa, 'mensal', duas), `${faixa} mensal ${notas}`);
      assert.equal(P.calcular(faixa, { notas, ciclo: 'anual' }).total, core.centavosDoCiclo(faixa, 'anual', duas), `${faixa} anual ${notas}`);
      // Guias: outra assinatura, R$ 197 por mês, ou R$ 100 com a NF-e (R$ 297 pelos dois).
      const comGuias = P.calcular(faixa, { notas, guias: true });
      assert.equal(comGuias.mensal, core.centavosDoCiclo(faixa, 'mensal', duas) + (duas ? core.MODULOS_JUNTOS - core.MODULO_SEGUNDA_NOTA : core.MODULO_GUIAS));
      assert.equal(comGuias.economia, duas ? 9700 : 0);
      // No anual o Guias fica fora do total do ano e aparece à parte, por mês.
      const anual = P.calcular(faixa, { notas, guias: true, ciclo: 'anual' });
      assert.equal(anual.total, core.centavosDoCiclo(faixa, 'anual', duas));
      assert.equal(anual.guiasAParte, duas ? 10000 : 19700);
    }
    assert.equal(P.calcular(faixa, { notas: ['nfe'] }).incluida, 'nfe', 'só NF-e: é ela que vem no plano');
  }
  // Inicial e Pro: só NFS-e, sem módulo, ainda que o link peça.
  for (const [plano, centavos] of [['inicial', 4900], ['pro', 12900]]) {
    const c = P.calcular(plano, { notas: ['nfse', 'nfe'], guias: true });
    assert.equal(c.mensal, centavos);
    assert.deepEqual(JSON.parse(JSON.stringify(c.escolha)), { notas: ['nfse'], guias: false });
    assert.equal(P.calcular(plano, { ciclo: 'anual' }).total, core.centavosDoCiclo(plano, 'anual'));
  }
  // Fundador: o preço da página é o cheio menos o valor do cupom que está no banco (script das faixas antigas e
  // migração das novas), e o cupom vale só na própria faixa.
  for (const [faixa, f] of Object.entries(P.FAIXAS)) {
    const linha = new RegExp(`\\('${f.cupom}', '[^']*', 'valor', (\\d+), 12, array\\['${faixa}'\\], 30, 20\\)`).exec(SQL + MIGRACAO);
    assert.ok(linha, `${f.cupom} no banco, na faixa ${faixa}`);
    assert.equal(f.fundador, f.centavos - Number(linha[1]), faixa);
    const c = P.calcular(faixa, { fundador: true, notas: ['nfse', 'nfe'] });
    assert.equal(c.mensal, f.fundador + 19700, 'o cupom vale só no preço do plano; o módulo entra cheio');
    assert.equal(c.cupom, f.cupom);
    assert.equal(P.calcular(faixa, { fundador: true, ciclo: 'anual' }).cupom, null, 'o anual não aceita cupom');
  }
  assert.match(MIGRACAO, /\('MODULOSJUNTOS', '[^']*', 'valor', 9700, null, array\['guias'\], null, null\)/);
  // Apelidos dos links (o volume no código) caem no código do servidor.
  assert.equal(P.faixa('escritorio_500'), 'escritorio_5');
  assert.equal(P.faixa('escritorio_2000'), 'escritorio_20');
  assert.equal(P.faixa('escritorio_5000'), 'escritorio_50');
  assert.equal(P.faixa('pro'), null);
});

test('sem JS a página não anuncia a Black Friday: faixa e selo escondidos, preço cheio no HTML', () => {
  assert.match(HTML, /<div class="fi-fundador" id="fi-fundador" hidden>/);
  assert.match(HTML, /<span class="fi-plano-ticket" id="fi-esc-ticket" hidden>/);
  assert.match(HTML, /<s class="fi-preco-de" data-de hidden><\/s><b data-valor>R\$ 297<\/b>/);
  assert.match(HTML, /id="fi-planos" data-ciclo="mensal" data-fundador="off"/);
  const css = ler('agentes/fiscal/fiscal.css');
  assert.match(css, /\.fi-planos\[data-ciclo="mensal"\] \[data-so-anual\]\{display:none\}/);
  // A página carrega a tabela de preços antes do script dos cards.
  assert.ok(HTML.indexOf('/agentes/fiscal/precos.js') > 0 && HTML.indexOf('/agentes/fiscal/precos.js') < HTML.indexOf('/agentes/fiscal/fiscal.js'));
  assert.ok(existsSync(resolve(repo, 'agentes/fiscal/precos.js')));
});

test('FAQ: planos por volume, NF-e, Guias, várias empresas e sob medida; a Agência saiu', () => {
  const faq = new Map([...HTML.matchAll(/<details\b[^>]*>\s*<summary\b[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g)].map((m) => [texto(m[1]), texto(m[2])]));
  assert.match(faq.get('Como emito várias notas de uma vez?'), /planilha \(\.xlsx ou \.csv\) no WhatsApp[\s\S]*até 1\.000 linhas/);
  assert.match(faq.get('Posso ter várias empresas na mesma conta?'), /sem limite de empresas[\s\S]*procuração eletrônica/);
  assert.match(faq.get('Emito mais de 10 mil documentos por mês ou quero integrar por API. Como faço?'), /sob medida[\s\S]*WhatsApp/);
  assert.match(faq.get('Como funciona a procuração eletrônica?'), /Portal de Serviços da Receita Federal/);
  assert.match(faq.get('O agente emite NF-e, a nota de produto?'), /plano Escritório[\s\S]*modelo 55[\s\S]*Sefaz/);
  assert.match(faq.get('O que é o módulo Guias?'), /Nada é enviado sem o seu clique em Disparar/);
  assert.match(faq.get('Quero emitir só NF-e. Preciso pagar pela NFS-e?'), /^Não\./);
  // Os preços do FAQ são os da tabela.
  const custa = faq.get('Quanto custa?');
  for (const f of Object.values(P.FAIXAS)) assert.ok(custa.includes(P.reais(f.centavos) + '/mês'), P.reais(f.centavos));
  assert.match(custa, /R\$ 197\/mês cada, ou R\$ 297\/mês os dois juntos/);
  assert.doesNotMatch([...faq.values()].join(' '), /até 5, 20 ou 50 empresas/);
  assert.ok(!faq.has('Qual a diferença entre Escritório e Agência?'));
});
