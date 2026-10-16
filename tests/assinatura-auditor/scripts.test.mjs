// Scripts do sandbox Pagar.me com fetch falso: nenhuma chamada de rede real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarPlanos } from '../../scripts/pagarme-assinatura/criar-planos-sandbox.mjs';
import { assinaturasDeTeste } from '../../scripts/pagarme-assinatura/assinatura-teste-sandbox.mjs';

function fetchFalso(responder) {
  const chamadas = [];
  const fn = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    chamadas.push({ url: String(url), init, body });
    const { status = 200, json = {} } = responder(String(url), body, chamadas.length);
    const txt = JSON.stringify(json);
    return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(txt), text: async () => txt };
  };
  fn.chamadas = chamadas;
  return fn;
}

function chavesProfundas(obj, acc = new Set()) {
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) { acc.add(k); chavesProfundas(v, acc); }
  }
  return acc;
}

/* ---------- criarPlanos ---------- */

for (const chave of ['sk_live_x', '', undefined]) {
  test(`criarPlanos com chave ${JSON.stringify(chave)}: CHAVE_NAO_SANDBOX e 0 fetch`, async () => {
    const f = fetchFalso(() => ({ json: { id: 'plan_x' } }));
    await assert.rejects(criarPlanos({ fetch: f, env: { PAGARME_ASSINATURA_SECRET_KEY: chave } }), /CHAVE_NAO_SANDBOX/);
    assert.equal(f.chamadas.length, 0);
  });
}

test('criarPlanos com sk_test_x: 3 POST em /plans com o corpo da v5 e retorna os ids', async () => {
  const f = fetchFalso((url, body, n) => ({ json: { id: `plan_${n}` } }));
  const r = await criarPlanos({ fetch: f, env: { PAGARME_ASSINATURA_SECRET_KEY: 'sk_test_x' } });
  assert.equal(f.chamadas.length, 3);
  const auth = `Basic ${Buffer.from('sk_test_x:').toString('base64')}`;
  for (const c of f.chamadas) {
    assert.equal(c.url, 'https://api.pagar.me/core/v5/plans');
    assert.equal(c.init.method, 'POST');
    assert.equal(c.init.headers.Authorization, auth);
    assert.equal(c.body.interval, 'month');
    assert.equal(c.body.interval_count, 1);
    assert.equal(c.body.billing_type, 'prepaid');
    assert.deepEqual(c.body.payment_methods, ['credit_card']);
    assert.equal(c.body.currency, 'BRL');
    assert.equal(c.body.items[0].quantity, 1);
    assert.equal(c.body.items[0].pricing_scheme.scheme_type, 'unit');
  }
  assert.deepEqual(f.chamadas.map((c) => c.body.items[0].pricing_scheme.price), [4700, 9700, 19700]);
  assert.deepEqual(f.chamadas.map((c) => c.body.metadata.codigo), ['mensal', 'semanal', 'agencia']);
  assert.deepEqual(r, [
    { codigo: 'mensal', env: 'PAGARME_PLANO_MENSAL_ID', id: 'plan_1' },
    { codigo: 'semanal', env: 'PAGARME_PLANO_SEMANAL_ID', id: 'plan_2' },
    { codigo: 'agencia', env: 'PAGARME_PLANO_AGENCIA_ID', id: 'plan_3' }
  ]);
});

test('criarPlanos usa PAGARME_ASSINATURA_API_URL sem barra final', async () => {
  const f = fetchFalso((url, body, n) => ({ json: { id: `plan_${n}` } }));
  await criarPlanos({ fetch: f, env: { PAGARME_ASSINATURA_SECRET_KEY: 'sk_test_x', PAGARME_ASSINATURA_API_URL: 'https://api.teste.local/core/v5/' } });
  assert.equal(f.chamadas[0].url, 'https://api.teste.local/core/v5/plans');
});

test('criarPlanos com HTTP 401: erro com o status, sem body e sem a chave', async () => {
  const f = fetchFalso(() => ({ status: 401, json: { message: 'segredo-do-body' } }));
  await assert.rejects(criarPlanos({ fetch: f, env: { PAGARME_ASSINATURA_SECRET_KEY: 'sk_test_x' } }), (e) => {
    assert.match(e.message, /401/);
    assert.doesNotMatch(e.message, /sk_test_x|segredo-do-body/);
    return true;
  });
  assert.equal(f.chamadas.length, 1);
});

test('criarPlanos com id sem plan_: erro', async () => {
  const f = fetchFalso(() => ({ json: { id: 'xyz' } }));
  await assert.rejects(criarPlanos({ fetch: f, env: { PAGARME_ASSINATURA_SECRET_KEY: 'sk_test_x' } }), /HTTP 200/);
});

/* ---------- assinaturasDeTeste ---------- */

for (const chave of ['pk_live_x', '', undefined]) {
  test(`assinaturasDeTeste com chave ${JSON.stringify(chave)}: CHAVE_NAO_SANDBOX e 0 fetch`, async () => {
    const f = fetchFalso(() => ({ json: { id: 'token_x' } }));
    await assert.rejects(assinaturasDeTeste({ fetch: f, env: { PAGARME_ASSINATURA_PUBLIC_KEY: chave } }), /CHAVE_NAO_SANDBOX/);
    assert.equal(f.chamadas.length, 0);
  });
}

test('assinaturasDeTeste com pk_test_x: 3 tokenizações + 3 POST na função, sem dado de cartão na função', async () => {
  const funcaoUrl = 'http://127.0.0.1:54321/functions/v1/assinatura-auditor';
  const f = fetchFalso((url, body, n) => (url.includes('/tokens')
    ? { json: { id: `token_${n}` } }
    : { json: { ok: true, status: 'paga', assinatura_id: `a${n}` } }));
  const r = await assinaturasDeTeste({ fetch: f, env: { PAGARME_ASSINATURA_PUBLIC_KEY: 'pk_test_x' }, funcaoUrl });

  const tokens = f.chamadas.filter((c) => c.url.includes('/tokens'));
  const funcao = f.chamadas.filter((c) => c.url === funcaoUrl);
  assert.equal(f.chamadas.length, 6);
  assert.equal(tokens.length, 3);
  assert.equal(funcao.length, 3);
  for (const t of tokens) {
    assert.equal(t.url, 'https://api.pagar.me/core/v5/tokens?appId=pk_test_x');
    assert.equal(t.init.method, 'POST');
    assert.equal(t.body.type, 'card');
    assert.equal(t.body.card.number, '4000000000000010');
  }
  const proibidas = ['number', 'cvv', 'holder_name', 'exp_month', 'exp_year', 'card'];
  funcao.forEach((c, i) => {
    const chaves = chavesProfundas(c.body);
    for (const k of proibidas) assert.ok(!chaves.has(k), `body da função não pode ter "${k}"`);
    assert.doesNotMatch(c.init.body, /4000000000000010/);
    assert.equal(c.body.card_token, `token_${i * 2 + 1}`);
    assert.equal(c.body.relatorio_aceite, true);
    assert.equal(c.body.termos_aceite, true);
    assert.equal(c.body.documento, '11144477735');
  });
  assert.deepEqual(funcao.map((c) => c.body.plano), ['mensal', 'semanal', 'agencia']);
  assert.deepEqual(r.map((x) => [x.codigo, x.http, x.resposta.ok]), [['mensal', 200, true], ['semanal', 200, true], ['agencia', 200, true]]);
});

test('assinaturasDeTeste sem funcaoUrl usa a função local padrão', async () => {
  const f = fetchFalso((url, body, n) => (url.includes('/tokens') ? { json: { id: `token_${n}` } } : { json: { ok: true } }));
  await assinaturasDeTeste({ fetch: f, env: { PAGARME_ASSINATURA_PUBLIC_KEY: 'pk_test_x' } });
  assert.equal(f.chamadas[1].url, 'http://127.0.0.1:54321/functions/v1/assinatura-auditor');
});
