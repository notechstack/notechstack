// Bordas do checkout e do webhook que o Landing do lote C fixa (sem banco: dependências em dublê).
import test from "node:test";
import assert from "node:assert/strict";
import { TEXTO_ACEITE_FISCAL, processarCheckout } from "../../supabase/functions/assinatura-fiscal/core.ts";
import { envelopeSeguro, mapearEvento, processarAviso } from "../../supabase/functions/assinatura-fiscal-webhook/core.ts";

const ENV = {
  PAGARME_ASSINATURA_SECRET_KEY: "sk_test_x",
  PAGARME_ASSINATURA_API_URL: "https://pagarme.simulado/core/v5",
  PAGARME_PLANO_FISCAL_INICIAL_ID: "plan_i",
  PAGARME_PLANO_FISCAL_PRO_ID: "plan_p",
  PAGARME_PLANO_FISCAL_INICIAL_SEM_TESTE_ID: "plan_is",
  PAGARME_PLANO_FISCAL_PRO_SEM_TESTE_ID: "plan_ps",
  FISCAL_VENDA_ABERTA: "sim",
  FISCAL_TRIAL_SALT: "sal",
};
const CONTEXTO = {
  tenant_id: "00000000-0000-4000-8000-000000000001",
  cnpj: "11444777000161",
  razao_social: "Empresa Teste",
  email: "dono@example.test",
  phone_e164: "+5511987654321",
  trial_ends_at: null,
  assinatura: null,
};
const PEDIDO = {
  plano: "pro",
  cpf: "123.456.789-09",
  card_token: "token_x",
  endereco: { cep: "01001000", rua: "Praça da Sé", numero: "1", bairro: "Sé", cidade: "São Paulo", uf: "SP" },
  termos_aceite: true,
  aceite_texto: TEXTO_ACEITE_FISCAL,
};

function dubles({ env = {}, contexto = CONTEXTO, sessao = "user-1", status = "future", http = 200, registrarLanca = false, rede = false } = {}) {
  const c = { fetch: [], reivindicar: [], registrar: [] };
  const deps = {
    env: { ...ENV, ...env },
    sessao: async () => sessao,
    contexto: async () => contexto,
    reivindicarTeste: async (t, h) => { c.reivindicar.push(h); return true; },
    registrar: async (l) => { c.registrar.push(l); if (registrarLanca) throw new Error("banco fora"); return { id: "a1", status: l.status }; },
    fetch: async (url, init = {}) => {
      c.fetch.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
      if (init.method === "DELETE") return { ok: true, status: 200, json: async () => ({}) };
      if (rede) throw new TypeError("fetch failed");
      return { ok: http < 300, status: http, json: async () => ({ id: "sub_1", status, customer: { id: "cus_1" } }) };
    },
    log: () => {},
  };
  return { deps, c };
}

test("configuração: venda fechada, sem sal, sem secret e chave fora do sandbox não chamam ninguém", async () => {
  for (const [env, http, code] of [
    [{ FISCAL_VENDA_ABERTA: "nao" }, 403, "VENDA_FECHADA"],
    [{ FISCAL_TRIAL_SALT: "" }, 500, "CONFIG_AUSENTE"],
    [{ PAGARME_ASSINATURA_SECRET_KEY: "" }, 500, "CONFIG_AUSENTE"],
    [{ PAGARME_ASSINATURA_SECRET_KEY: "sk_live_x" }, 500, "CHAVE_NAO_SANDBOX"],
  ]) {
    const { deps, c } = dubles({ env });
    const r = await processarCheckout(PEDIDO, deps);
    assert.equal(r.http, http, code);
    assert.equal(r.body.error_code, code);
    assert.equal(c.fetch.length + c.reivindicar.length + c.registrar.length, 0, code);
  }
});

test("sessão, empresa, assinatura existente e plano indisponível param antes de reivindicar", async () => {
  const casos = [
    [{ sessao: null }, 401, "SEM_SESSAO"],
    [{ contexto: null }, 403, "CONTA_SEM_EMPRESA"],
    [{ contexto: { ...CONTEXTO, assinatura: { status: "pendente" } } }, 409, "ASSINATURA_EXISTENTE"],
    [{ contexto: { ...CONTEXTO, assinatura: { status: "recusada" } } }, 409, "ASSINATURA_EXISTENTE"],
    [{ env: { PAGARME_PLANO_FISCAL_PRO_SEM_TESTE_ID: "" } }, 409, "PLANO_INDISPONIVEL"],
  ];
  for (const [opcoes, http, code] of casos) {
    const { deps, c } = dubles(opcoes);
    const r = await processarCheckout(PEDIDO, deps);
    assert.equal(r.http, http, code);
    assert.equal(r.body.error_code, code);
    assert.equal(c.fetch.length + c.reivindicar.length + c.registrar.length, 0, code);
  }
  // Assinatura anterior cancelada não impede uma nova.
  const { deps } = dubles({ contexto: { ...CONTEXTO, assinatura: { status: "cancelada" } } });
  assert.equal((await processarCheckout(PEDIDO, deps)).http, 200);
});

test("dados do cartão, CPF e plano inválidos → 400 sem chamar ninguém", async () => {
  for (const extra of [{ card: {} }, { number: "4111" }, { cvv: "1" }, { cpf: "123" }, { plano: "mensal" }, { card_token: "x" }, { endereco: null }]) {
    const { deps, c } = dubles();
    const r = await processarCheckout({ ...PEDIDO, ...extra }, deps);
    assert.equal(r.http, 400, JSON.stringify(extra));
    assert.equal(c.fetch.length + c.reivindicar.length, 0);
  }
});

// Lucca, 22/10/2026: o cadastro não pede mais CPF; sem ele, o reteste fica com CNPJ, e-mail e telefone.
test("sem CPF o checkout segue, e o reteste usa só CNPJ, e-mail e telefone", async () => {
  const { deps, c } = dubles();
  const r = await processarCheckout({ ...PEDIDO, cpf: undefined }, deps);
  assert.equal(r.http, 200, JSON.stringify(r.body));
  assert.deepEqual(Object.keys(c.reivindicar[0]).sort(), ["cnpj", "email", "phone"]);
});

test("cliente do Pagar.me é a empresa do contexto, nunca o corpo", async () => {
  const { deps, c } = dubles();
  await processarCheckout({ ...PEDIDO, email: "outro@x.test", nome: "Outro" }, deps);
  const body = c.fetch[0].body;
  assert.equal(body.customer.name, "Empresa Teste");
  assert.equal(body.customer.email, "dono@example.test");
  assert.equal(body.customer.document, "11444777000161");
  assert.deepEqual(body.customer.phones.mobile_phone, { country_code: "55", area_code: "11", number: "987654321" });
  assert.deepEqual(body.metadata, { origem: "agente-fiscal", tenant_id: CONTEXTO.tenant_id, plano: "pro", com_teste: true });
  assert.equal(body.card.billing_address.zip_code, "01001000");
  // O CPF do dono entra só em hash.
  assert.equal(JSON.stringify(body).includes("12345678909"), false);
  assert.match(c.reivindicar[0].cpf, /^[0-9a-f]{64}$/);
});

test("recusa na criação: não registra, cancela no Pagar.me e responde 402", async () => {
  for (const status of ["failed", "canceled"]) {
    const { deps, c } = dubles({ status });
    const r = await processarCheckout(PEDIDO, deps);
    assert.equal(r.http, 402);
    assert.equal(r.body.error_code, "PAGAMENTO_RECUSADO");
    assert.equal(c.registrar.length, 0);
    assert.deepEqual(c.fetch.map((f) => f.method), ["POST", "DELETE"]);
    assert.equal(c.fetch[1].url, "https://pagarme.simulado/core/v5/subscriptions/sub_1");
    assert.deepEqual(c.fetch[1].body, { cancel_pending_invoices: true });
  }
});

test("falha do Pagar.me e do registro", async () => {
  for (const opcoes of [{ http: 500 }, { rede: true }]) {
    const { deps, c } = dubles(opcoes);
    const r = await processarCheckout(PEDIDO, deps);
    assert.equal(r.http, 502);
    assert.equal(r.body.error_code, "PAGARME_FALHOU");
    assert.equal(c.registrar.length, 0);
  }
  const { deps, c } = dubles({ registrarLanca: true });
  const r = await processarCheckout(PEDIDO, deps);
  assert.equal(r.http, 500);
  assert.equal(r.body.error_code, "REGISTRO_FALHOU");
  assert.deepEqual(c.fetch.map((f) => f.method), ["POST", "DELETE"]);
});

const ENV_WEBHOOK = { PAGARME_FISCAL_WEBHOOK_USER: "u", PAGARME_FISCAL_WEBHOOK_PASS: "p" };
const BASIC = `Basic ${Buffer.from("u:p").toString("base64")}`;

test("webhook: sem Basic Auth certo responde 401 sem processar", async () => {
  for (const [authorization, env] of [
    [null, ENV_WEBHOOK],
    ["", ENV_WEBHOOK],
    [`Basic ${Buffer.from("u:errada").toString("base64")}`, ENV_WEBHOOK],
    [BASIC, { PAGARME_FISCAL_WEBHOOK_USER: "u", PAGARME_FISCAL_WEBHOOK_PASS: "" }],
  ]) {
    const chamadas = [];
    const r = await processarAviso(
      { metodo: "POST", authorization, body: { id: "hook_1", type: "invoice.paid", data: {} } },
      { env, aplicarEvento: async (a) => { chamadas.push(a); return {}; }, log: () => {} },
    );
    assert.equal(r.http, 401);
    assert.equal(chamadas.length, 0);
  }
  const r = await processarAviso({ metodo: "GET", authorization: BASIC, body: {} }, { env: ENV_WEBHOOK, aplicarEvento: async () => ({}), log: () => {} });
  assert.equal(r.http, 405);
  const sem = await processarAviso({ metodo: "POST", authorization: BASIC, body: { type: "invoice.paid" } }, { env: ENV_WEBHOOK, aplicarEvento: async () => ({}), log: () => {} });
  assert.equal(sem.http, 400);
});

test("webhook: mapa dos eventos documentados e envelope sem dado pessoal", async () => {
  assert.equal(mapearEvento("invoice.paid", {}).status, "paga");
  assert.equal(mapearEvento("charge.paid", {}).status, "paga");
  assert.equal(mapearEvento("invoice.payment_failed", {}).status, "recusada");
  assert.equal(mapearEvento("charge.payment_failed", {}).status, "recusada");
  assert.equal(mapearEvento("subscription.canceled", { id: "sub_9" }).status, "cancelada");
  assert.equal(mapearEvento("subscription.canceled", { id: "sub_9" }).subscriptionId, "sub_9");
  for (const t of ["subscription.payment_failed", "subscription.created", "invoice.created", "charge.refunded"]) {
    assert.equal(mapearEvento(t, {}).status, null, t);
  }
  const env = envelopeSeguro("hook_1", "charge.paid", {
    id: "ch_1", status: "paid", customer: { id: "cus_1", email: "x@y.test", document: "12345678909" },
    invoice: { id: "in_1", subscription: { id: "sub_1" } }, last_transaction: { card: { last_four_digits: "1111" } },
  });
  const texto = JSON.stringify(env);
  for (const proibido of ["x@y.test", "12345678909", "1111"]) assert.equal(texto.includes(proibido), false, proibido);
  assert.equal(env.data.subscription_id, "sub_1");

  const chamadas = [];
  const r = await processarAviso(
    { metodo: "POST", authorization: BASIC, body: { id: "hook_2", type: "invoice.paid", created_at: "2026-11-01T09:00:00-03:00", data: { subscription: { id: "sub_1" } } } },
    { env: ENV_WEBHOOK, aplicarEvento: async (a) => { chamadas.push(a); return { applied: true, duplicado: false }; }, log: () => {} },
  );
  assert.equal(r.http, 200);
  assert.equal(chamadas[0].p_evento_em, "2026-11-01T12:00:00.000Z");
  assert.equal(chamadas[0].p_status, "paga");
  assert.equal(chamadas[0].p_subscription_id, "sub_1");
});
