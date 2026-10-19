// Medição do checkout (agentes/auditor/assinatura-medicao.js) rodada em node:vm, sem navegador.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ARQ = fileURLToPath(new URL('../../agentes/auditor/assinatura-medicao.js', import.meta.url));
const CODIGO = readFileSync(ARQ, 'utf8');
const ID_RE = /^assin_[0-9a-f-]{36}$/;
const plain = (x) => JSON.parse(JSON.stringify(x)); // objetos do vm vêm de outro realm

function montar(consent, crypto = webcrypto) {
  const store = consent === undefined ? {} : { no_auditor_consent: consent };
  const localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); }
  };
  const fbqChamadas = [];
  const fbq = (...args) => { fbqChamadas.push(args); };
  const window = { dataLayer: [], fbq, localStorage, crypto };
  const ctx = { window, localStorage, crypto };
  vm.createContext(ctx);
  vm.runInContext(CODIGO, ctx, { filename: 'assinatura-medicao.js' });
  return { window, fbqChamadas, api: window.noAssinaturaMedicao };
}

for (const [rotulo, consent] of [['recusado', 'denied'], ['sem escolha', undefined]]) {
  test(`consentimento ${rotulo}: retorna null, 0 push no dataLayer, 0 fbq`, () => {
    const { window, fbqChamadas, api } = montar(consent);
    assert.equal(api.iniciada('semanal'), null);
    assert.equal(api.concluida('semanal'), null);
    assert.equal(window.dataLayer.length, 0);
    assert.equal(fbqChamadas.length, 0);
  });
}

test('localStorage que lança erro conta como recusado', () => {
  const { window, fbqChamadas, api } = montar('granted');
  // mesmo objeto no window e no topo do contexto
  window.localStorage.getItem = () => { throw new Error('bloqueado'); };
  assert.equal(api.iniciada('mensal'), null);
  assert.equal(api.concluida('mensal'), null);
  assert.equal(window.dataLayer.length, 0);
  assert.equal(fbqChamadas.length, 0);
});

test('consentimento aceito: 2 eventos com ids novos, dataLayer e fbq com o mesmo eventID', () => {
  const { window, fbqChamadas, api } = montar('granted');
  const idIni = api.iniciada('semanal');
  const idCon = api.concluida('semanal');
  assert.match(idIni, ID_RE);
  assert.match(idCon, ID_RE);
  assert.notEqual(idIni, idCon);

  const dl = plain(window.dataLayer);
  assert.equal(dl.length, 2);
  assert.deepEqual(dl[0], { event: 'assinatura_iniciada', event_id: idIni, plano: 'semanal', valor: 97, moeda: 'BRL' });
  assert.deepEqual(dl[1], { event: 'assinatura_concluida', event_id: idCon, plano: 'semanal', valor: 97, moeda: 'BRL' });

  const f = plain(fbqChamadas);
  assert.equal(f.length, 2);
  assert.deepEqual(f[0], ['track', 'InitiateCheckout', { value: 97, currency: 'BRL', content_name: 'semanal' }, { eventID: dl[0].event_id }]);
  assert.deepEqual(f[1], ['track', 'Subscribe', { value: 97, currency: 'BRL', predicted_ltv: 97 }, { eventID: dl[1].event_id }]);
});

test('valores por plano: mensal 47, semanal 97, agencia 197', () => {
  const { window, api } = montar('granted');
  for (const [plano, valor] of [['mensal', 47], ['semanal', 97], ['agencia', 197]]) {
    const id = api.concluida(plano);
    const ev = plain(window.dataLayer.at(-1));
    assert.equal(ev.event_id, id);
    assert.equal(ev.valor, valor);
    assert.equal(ev.moeda, 'BRL');
  }
});

test('plano desconhecido: null e nada disparado, mesmo com consentimento', () => {
  const { window, fbqChamadas, api } = montar('granted');
  assert.equal(api.iniciada('anual'), null);
  assert.equal(api.concluida(undefined), null);
  assert.equal(api.iniciada('toString'), null);
  assert.equal(window.dataLayer.length, 0);
  assert.equal(fbqChamadas.length, 0);
});

test('sem fbq: só o dataLayer recebe o evento', () => {
  const { window, api } = montar('granted');
  delete window.fbq;
  const id = api.iniciada('agencia');
  assert.match(id, ID_RE);
  assert.equal(window.dataLayer.length, 1);
});

test('fallback sem randomUUID: getRandomValues monta uuid v4', () => {
  const soRandom = { getRandomValues: (a) => webcrypto.getRandomValues(a) };
  const { api } = montar('granted', soRandom);
  const id = api.iniciada('mensal');
  assert.match(id, /^assin_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(api.iniciada('mensal'), id);
});
