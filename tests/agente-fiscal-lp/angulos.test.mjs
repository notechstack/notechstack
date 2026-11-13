// Lucca, 13/11/2026: LP preparada para o remarketing. (1) O anúncio leva ?angulo=<chave> e o hero repete a promessa
// dele (a1, preco, escritorio); quem já simulou e volta sem ângulo vê "voltou"; chave desconhecida = página padrão.
// (2) A simulação concluída vira evento próprio (dataLayer nofiscal_simulacao e Pixel SimulacaoNota, só com aceite),
// o público mais quente do remarketing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrirPagina, HTML } from './pagina-falsa.mjs';

const H1_PADRAO = 'Já pensou em emitir sua nota fiscal direto no WhatsApp?';
const doDl = (p, nome) => p.dataLayer().filter((e) => e && e.event === nome);
const js = (v) => JSON.parse(JSON.stringify(v));

test('sem ângulo e sem simulação: hero padrão, sem CTA extra', () => {
  const p = abrirPagina();
  assert.equal(p.el('fi-titulo').textContent, H1_PADRAO);
  assert.equal(p.el('fi-hero-cta').hidden, true);
  assert.equal(doDl(p, 'nofiscal_view_content')[0].angulo, undefined);
});

test('o CTA do hero nasce escondido no HTML', () => {
  assert.match(HTML, /<p class="fi-hero-cta" id="fi-hero-cta" hidden>/);
});

for (const [angulo, h1, href] of [
  ['a1', 'Só falta o certificado A1.', '#certificado-a1'],
  ['preco', '7 dias grátis pra emitir de verdade.', '#planos'],
  ['escritorio', 'As notas do mês de todos os clientes numa planilha.', '#planos']
]) {
  test(`?angulo=${angulo}: hero do anúncio, CTA visível e ângulo na visita`, () => {
    const p = abrirPagina({ search: '?angulo=' + angulo + '&utm_source=meta' });
    assert.equal(p.el('fi-titulo').textContent, h1);
    assert.ok(p.el('fi-hero-sub').textContent.length > 40, 'subtítulo trocado');
    assert.equal(p.el('fi-hero-cta').hidden, false);
    assert.ok(p.el('fi-hero-cta-link').textContent.length > 0);
    assert.equal(p.ctx.document.documentElement.atributos['data-angulo'], angulo);
    assert.equal(doDl(p, 'nofiscal_view_content')[0].angulo, angulo);
    assert.ok(href.startsWith('#'));
  });
}

test('ângulo desconhecido ou com HTML: página padrão', () => {
  for (const s of ['?angulo=xyz', '?angulo=%3Cimg%20src%3Dx%3E', '?angulo=__proto__', '?angulo=']) {
    const p = abrirPagina({ search: s });
    assert.equal(p.el('fi-titulo').textContent, H1_PADRAO, s);
    assert.equal(p.el('fi-hero-cta').hidden, true, s);
  }
});

test('quem já simulou e volta sem ângulo vê "voltou"; o ângulo do anúncio vence', () => {
  const navegador = new Map([['no_fiscal_simulacoes', '2']]);
  const p = abrirPagina({ armazenamento: navegador });
  assert.equal(p.el('fi-titulo').textContent, 'Agora a nota sai do seu CNPJ.');
  assert.equal(doDl(p, 'nofiscal_view_content')[0].angulo, 'voltou');
  const q = abrirPagina({ armazenamento: navegador, search: '?angulo=a1' });
  assert.equal(q.el('fi-titulo').textContent, 'Só falta o certificado A1.');
});

test('simulação concluída: nofiscal_simulacao no dataLayer e SimulacaoNota no Pixel com aceite', async () => {
  const fbq = [];
  const p = abrirPagina({
    armazenamento: new Map([['no_fiscal_consent', 'granted']]),
    extras: { fbq: (...a) => fbq.push(a), noMarketingHostAllowed: () => true, fetch: () => Promise.resolve({ ok: true }) }
  });
  await p.emitirProntia();
  const ev = doDl(p, 'nofiscal_simulacao');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].simulacoes, 1);
  assert.equal(ev[0].limite, undefined);
  const px = fbq.find((a) => a[0] === 'trackCustom' && a[1] === 'SimulacaoNota');
  assert.ok(px, 'Pixel recebeu SimulacaoNota');
  assert.deepEqual(js(px[2]), { simulacoes: 1 });
  assert.equal(px[3].eventID, ev[0].event_id);
  assert.equal(p.ctx.noFiscalMedicao.capi.length, 0, 'sinal de público, não vai à CAPI');
  // a 3ª simulação marca o limite
  await p.emitirProntia();
  await p.emitirProntia();
  assert.equal(doDl(p, 'nofiscal_simulacao').at(-1).limite, true);
});

test('simulação sem aceite: dataLayer sim, Pixel não', async () => {
  const fbq = [];
  const p = abrirPagina({ extras: { fbq: (...a) => fbq.push(a) } });
  await p.emitirProntia();
  assert.equal(doDl(p, 'nofiscal_simulacao').length, 1);
  assert.equal(fbq.filter((a) => a[0] === 'track' || a[0] === 'trackCustom').length, 0);
});

test('FAQ do Lucro Presumido: lista de espera pelo WhatsApp vira Lead "presumido"', () => {
  assert.match(HTML, /<a data-lead="presumido" href="https:\/\/wa\.me\/5511939289413\?text=[^"]*Lucro%20Presumido[^"]*" target="_blank"/);
  const p = abrirPagina();
  p.ctx.noFiscalMedicao.lead('presumido', 'whatsapp');
  const ev = doDl(p, 'nofiscal_lead').at(-1);
  assert.equal(ev.plano, 'presumido');
});
