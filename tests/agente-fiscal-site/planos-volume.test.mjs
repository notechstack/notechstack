// Planos por volume e módulos (Lucca, 23/11/2026), no navegador de mentira com os scripts de verdade:
// - cadastro: as caixas "O que você vai emitir?", o resumo do preço linha a linha e o que vai ao servidor;
// - LP: o card do Escritório refaz o preço e o link do cadastro a cada caixa, faixa e ciclo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrir, superficie, sessaoValida, estado, preencherCartao, ACEITE } from './pagina-falsa.mjs';
import { JSDOM } from 'jsdom';
import { ler as lerArquivo } from './pagina-falsa.mjs';

/** A LP com precos.js e fiscal.js de verdade. O resto da página (vídeos, simulador, fundo) não entra na conta dos cards:
    com movimento reduzido e sem IntersectionObserver o script segue pelos caminhos sem animação. */
function abrirLp(caminho) {
  const dom = new JSDOM(lerArquivo('agentes/fiscal/index.html'), { url: 'http://localhost:3000' + caminho, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  w.eval(lerArquivo('agentes/fiscal/precos.js'));
  try { w.eval(lerArquivo('agentes/fiscal/fiscal.js')); } catch (e) { /* o que vem depois dos planos não importa aqui */ }
  return { document: w.document, esvaziar: async () => { await new Promise((r) => setTimeout(r, 0)); } };
}

const CHECKOUT = { ok: true, venda_aberta: true, anual_disponivel: true, escritorio_disponivel: true, escritorio_anual_disponivel: true, public_key: 'pk_test_abc', aceite_texto: ACEITE, planos: {} };

function noPagamento(caminho, { plano = 'escritorio_1000', resposta = {} } = {}) {
  const rede = superficie({
    'GET assinatura-fiscal': () => ({ status: 200, corpo: CHECKOUT }),
    'POST assinatura-fiscal': () => ({ status: 200, corpo: { ok: true, status: 'pendente', assinatura_id: 'a-9', com_teste: true, medicao: { evento: 'StartTrial', event_id: 'nofiscal-trial-a-9', transaction_id: 'a-9', valor: 1, moeda: 'BRL' }, ...resposta } }),
    'fiscal-conta:estado': () => ({ status: 200, corpo: estado({ plano, onboarding_etapa: 'pagamento', assinatura: null }) })
  });
  return abrir(caminho, { rede, local: { 'nofiscal.sessao': sessaoValida() } }).then((p) => ({ p, rede }));
}
const resumo = (p) => [...p.$('fc-resumo-preco').querySelectorAll('li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim());
async function marcar(p, valor, sim) {
  const caixa = p.document.querySelector(`input[name="fc-modulo"][value="${valor}"]`);
  caixa.checked = sim;
  caixa.dispatchEvent(new p.window.Event('change', { bubbles: true }));
  await p.esvaziar(40);
  return caixa;
}

test('cadastro do Escritório: caixas do link, resumo linha a linha e pedido com notas e guias', async () => {
  const { p, rede } = await noPagamento('/agentes/fiscal/comecar/?tipo=escritorio&plano=escritorio_1000&notas=nfse,nfe&guias=1');
  assert.equal(p.etapa(), 3);
  assert.ok(p.visivel('fc-modulos'));
  assert.deepEqual([...p.document.querySelectorAll('input[name="fc-faixa"]')].map((r) => r.value),
    ['escritorio_5', 'escritorio_1000', 'escritorio_20', 'escritorio_50', 'escritorio_10000'], 'as faixas vão com o código do servidor');
  assert.deepEqual([...p.document.querySelectorAll('input[name="fc-modulo"]')].map((c) => [c.value, c.checked]), [['nfse', true], ['nfe', true], ['guias', true]]);
  assert.deepEqual(resumo(p), [
    'Plano Escritório 1.000 · 1.000 documentos/mêsR$ 497', 'NFS-eincluída', 'NF-e+ R$ 197', 'Guias+ R$ 197', 'NF-e e Guias juntos− R$ 97', 'TotalR$ 794/mês',
  ]);
  assert.equal(p.texto('fc-plano-pagamento'), 'Plano Escritório 1.000 · R$ 794/mês · 7 dias grátis');
  // A caixa do tipo que vem no plano não leva rótulo; a outra mostra o preço.
  assert.equal(p.document.querySelector('[data-modulo-preco="nfse"]').textContent, '');
  assert.equal(p.document.querySelector('[data-modulo-preco="nfe"]').textContent, '+R$ 197/mês');

  // Só NF-e: ela passa a ser a nota do plano, e a NFS-e é que custa a mais.
  await marcar(p, 'nfse', false);
  assert.deepEqual(resumo(p), ['Plano Escritório 1.000 · 1.000 documentos/mêsR$ 497', 'NF-eincluída', 'Guias+ R$ 197', 'TotalR$ 694/mês']);
  assert.equal(p.document.querySelector('[data-modulo-preco="nfe"]').textContent, '');
  assert.equal(p.document.querySelector('[data-modulo-preco="nfse"]').textContent, '+R$ 197/mês');
  // A última caixa de nota não desmarca: sem tipo de nota o plano não emite nada.
  const nfe = await marcar(p, 'nfe', false);
  assert.equal(nfe.checked, true);
  assert.deepEqual(resumo(p).at(-1), 'TotalR$ 694/mês');

  await preencherCartao(p);
  await p.marcar('fc-aceite');
  await p.enviar('fc-form-3');
  const [pedido] = rede.de('POST assinatura-fiscal').filter((v) => v.corpo.acao === undefined);
  assert.equal(pedido.corpo.plano, 'escritorio_1000');
  assert.deepEqual(pedido.corpo.notas, ['nfe']);
  assert.equal(pedido.corpo.guias, true);
  assert.equal(p.etapa(), 4);
});

test('cadastro no anual: o segundo tipo de nota entra no ano com o desconto; o Guias fica à parte, por mês', async () => {
  const { p, rede } = await noPagamento('/agentes/fiscal/comecar/?tipo=escritorio&plano=escritorio_2000&ciclo=anual&notas=nfse,nfe&guias=1', { plano: 'escritorio_20' });
  assert.equal(p.document.querySelector('input[name="fc-faixa"]:checked').value, 'escritorio_20', 'o apelido do link vira o código do servidor');
  // (797 + 197) × 12 = 11.928; 30% OFF = 8.349,60 por ano; o Guias (R$ 100 com a NF-e) é cobrado por mês.
  assert.deepEqual(resumo(p), [
    'Plano Escritório 2.000 · 2.000 documentos/mêsR$ 797', 'NFS-eincluída', 'NF-e+ R$ 197', '12 mesesR$ 11.928',
    'Desconto do anual (30%)− R$ 3.578,40', 'TotalR$ 8.349,60/ano', 'Guias, cobrado por mês em outra fatura+ R$ 100/mês',
  ]);
  await preencherCartao(p);
  await p.marcar('fc-aceite');
  await p.enviar('fc-form-3');
  const [pedido] = rede.de('POST assinatura-fiscal').filter((v) => v.corpo.acao === undefined);
  assert.equal(pedido.corpo.ciclo, 'anual');
  assert.deepEqual(pedido.corpo.notas, ['nfse', 'nfe']);
  assert.equal(pedido.corpo.guias, true);
});

test('módulo que não ligou: a assinatura vale e a etapa seguinte avisa', async () => {
  const { p } = await noPagamento('/agentes/fiscal/comecar/?tipo=escritorio&plano=escritorio_5&guias=1', { plano: 'escritorio_5', resposta: { modulos_pendentes: ['guias'] } });
  await preencherCartao(p);
  await p.marcar('fc-aceite');
  await p.enviar('fc-form-3');
  assert.equal(p.etapa(), 4);
  assert.match(p.texto('fc-aviso-4'), /^Assinatura feita\. Guias ainda não foi ligado na sua conta: a nó liga para você/);
});

test('Inicial e Pro no cadastro: sem caixas de módulo; NF-e e Guias do link são ignorados', async () => {
  const { p, rede } = await noPagamento('/agentes/fiscal/comecar/?plano=pro&notas=nfse,nfe&guias=1', { plano: 'pro' });
  assert.equal(p.etapa(), 3);
  assert.equal(p.visivel('fc-modulos'), false);
  assert.equal(p.visivel('fc-faixas'), false);
  assert.deepEqual(resumo(p), ['Plano Pro · 100 notas/mêsR$ 129', 'NFS-eincluída', 'TotalR$ 129/mês']);
  await preencherCartao(p);
  await p.marcar('fc-aceite');
  await p.enviar('fc-form-3');
  const [pedido] = rede.de('POST assinatura-fiscal').filter((v) => v.corpo.acao === undefined);
  assert.deepEqual(pedido.corpo.notas, ['nfse']);
  assert.equal(pedido.corpo.guias, undefined);
});

test('LP: o card do Escritório refaz preço, conta e link a cada caixa, faixa e ciclo', async () => {
  const p = abrirLp('/agentes/fiscal/?fundador=off');
  const d = p.document;
  const card = d.querySelector('.fi-plano[data-plano="escritorio"]');
  const ler = () => ({
    valor: card.querySelector('[data-valor]').textContent, conta: card.querySelector('[data-conta]').hidden ? '' : card.querySelector('[data-conta]').textContent,
    cabe: card.querySelector('[data-cabe]').textContent, href: card.querySelector('#fi-esc-cta').getAttribute('href'),
  });
  const clicar = async (el) => { el.click(); await p.esvaziar(10); };
  assert.deepEqual(ler(), { valor: 'R$ 297', conta: '', cabe: '500 documentos por mês', href: '/agentes/fiscal/comecar/?tipo=escritorio&plano=escritorio_5' });

  await clicar(card.querySelector('input[value="nfe"]'));
  await clicar(card.querySelector('input[value="guias"]'));
  assert.deepEqual(ler(), {
    valor: 'R$ 594', conta: 'Plano R$ 297 + NF-e R$ 197 + Guias R$ 197 − R$ 97 por levar os dois', cabe: '500 documentos por mês',
    href: '/agentes/fiscal/comecar/?tipo=escritorio&plano=escritorio_5&notas=nfse,nfe&guias=1',
  });
  await clicar(card.querySelector('[data-faixa="escritorio_10000"]'));
  assert.equal(ler().valor, 'R$ 2.794');
  assert.equal(ler().cabe, '10.000 documentos por mês');
  assert.match(ler().href, /plano=escritorio_10000&notas=nfse,nfe&guias=1$/);

  // Anual: o ano do plano com a NF-e e o desconto da faixa; o Guias aparece à parte.
  await clicar(d.querySelector('.fi-ciclo-toggle [data-ciclo="anual"]'));
  assert.equal(ler().valor, 'R$ 1.481,70'); // (2.497 + 197) × 0,55
  assert.equal(ler().conta, 'Plano R$ 2.497 + NF-e R$ 197, com 45% OFF no anual. Guias: + R$ 100/mês, cobrado à parte.');
  assert.match(card.querySelector('[data-depois]').textContent, /R\$ 17\.780,40\/ano/);
  assert.match(ler().href, /&ciclo=anual$/);

  // Sob medida: sem preço nem caixas, e o botão vai ao WhatsApp.
  await clicar(card.querySelector('[data-faixa="sob_medida"]'));
  assert.equal(ler().valor, 'Sob medida');
  assert.equal(card.querySelector('.fi-modulos').hidden, true);
  assert.equal(d.getElementById('fi-esc-cta').hidden, true);
  assert.equal(d.getElementById('fi-esc-zap').hidden, false);
});

test('LP na Black Friday: as cinco faixas com selo, preço de fundador e cupom no link; no anual, sem cupom', async () => {
  const p = abrirLp('/agentes/fiscal/');
  if (Date.now() >= Date.parse('2026-12-01T00:00:00-03:00')) return; // a oferta saiu do ar: o teste de cima cobre o depois
  const card = p.document.querySelector('.fi-plano[data-plano="escritorio"]');
  const esperado = {
    escritorio_5: ['R$ 247', '17% OFF', 'FUNDADOR5'], escritorio_1000: ['R$ 397', '20% OFF', 'FUNDADOR1000'], escritorio_20: ['R$ 647', '19% OFF', 'FUNDADOR20'],
    escritorio_50: ['R$ 1.197', '20% OFF', 'FUNDADOR50'], escritorio_10000: ['R$ 1.997', '20% OFF', 'FUNDADOR10000'],
  };
  for (const [faixa, [valor, selo, cupom]] of Object.entries(esperado)) {
    card.querySelector(`[data-faixa="${faixa}"]`).click();
    await p.esvaziar(10);
    assert.equal(card.querySelector('[data-valor]').textContent, valor, faixa);
    assert.equal(p.document.getElementById('fi-esc-ticket').hidden, false, faixa);
    assert.equal(p.document.getElementById('fi-esc-ticket-off').textContent, selo, faixa);
    assert.equal(card.querySelector('#fi-esc-cta').getAttribute('href'), `/agentes/fiscal/comecar/?tipo=escritorio&plano=${faixa}&cupom=${cupom}`);
    assert.equal(card.querySelector('#fi-esc-cta').textContent, 'Testar 1 mês grátis');
  }
  p.document.querySelector('.fi-ciclo-toggle [data-ciclo="anual"]').click();
  await p.esvaziar(10);
  assert.equal(p.document.getElementById('fi-esc-ticket').hidden, true);
  assert.doesNotMatch(card.querySelector('#fi-esc-cta').getAttribute('href'), /cupom=/);
});
