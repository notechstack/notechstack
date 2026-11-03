// Medição da cobrança paga do nó.fiscal (03/11/2026): cobrança depois do teste e renovações viram Purchase na Meta
// CAPI e purchase no GA4, pelo webhook, só com o consentimento gravado no checkout. Sem banco: dependências em dublê
// (as regras de banco ficam em public.fiscal_reivindicar_cobranca, migração 20261103130000).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { TEXTO_ACEITE_FISCAL, processarCheckout } from "../../supabase/functions/assinatura-fiscal/core.ts";
import { clientIdGa4, enviarParaGa4 } from "../../supabase/functions/assinatura-fiscal/medicao.ts";
import { pagamentoDoAviso, processarAviso } from "../../supabase/functions/assinatura-fiscal-webhook/core.ts";
import { medirCobranca } from "../../supabase/functions/assinatura-fiscal-webhook/compra.ts";

const sha = (v) => createHash("sha256").update(v).digest("hex");
const TENANT = "00000000-0000-4000-8000-000000000001";
const FBP = "fb.1.1761140000000.1234567890";
const FBC = "fb.1.1761140000000.IwAR0abcDEF_ghi-123";

test("pagamentoDoAviso: invoice.paid e charge.paid do mesmo pagamento dão a mesma chave (a fatura)", () => {
  const fatura = { id: "in_1", amount: 12900, subscription: { id: "sub_1" }, charge: { id: "ch_1", paid_amount: 12900 } };
  const cobranca = { id: "ch_1", amount: 12900, paid_amount: 12900, invoice: { id: "in_1", subscription_id: "sub_1" } };
  assert.deepEqual(pagamentoDoAviso("invoice.paid", fatura), { chave: "in_1", centavos: 12900 });
  assert.deepEqual(pagamentoDoAviso("charge.paid", cobranca), { chave: "in_1", centavos: 12900 });
  // sem fatura: a cobrança
  assert.deepEqual(pagamentoDoAviso("charge.paid", { id: "ch_9", amount: 4900 }), { chave: "ch_9", centavos: 4900 });
  // valor pago com desconto vence o valor cheio; sem valor, null (compra.ts usa o preço do plano)
  assert.equal(pagamentoDoAviso("charge.paid", { id: "ch_2", amount: 12900, paid_amount: 6450 }).centavos, 6450);
  assert.equal(pagamentoDoAviso("invoice.paid", { id: "in_2" }).centavos, null);
  // só cobrança paga
  for (const tipo of ["charge.payment_failed", "invoice.payment_failed", "subscription.canceled", "invoice.created"]) {
    assert.equal(pagamentoDoAviso(tipo, fatura), null, tipo);
  }
  assert.equal(pagamentoDoAviso("invoice.paid", {}), null);
});

const WEBHOOK_ENV = { PAGARME_FISCAL_WEBHOOK_USER: "u", PAGARME_FISCAL_WEBHOOK_PASS: "p" };
const BASIC = `Basic ${btoa("u:p")}`;

async function aviso(tipo, data, resultadoDoBanco, medidas) {
  return processarAviso(
    { metodo: "POST", authorization: BASIC, body: { id: `hook_${Math.random()}`, type: tipo, data } },
    {
      env: WEBHOOK_ENV,
      aplicarEvento: async () => resultadoDoBanco,
      log: () => {},
      medirCobranca: async (args) => { medidas.push(args); return { resultado: "enviado" }; },
    },
  );
}

test("webhook: mede só cobrança paga com assinatura, e não mede aviso repetido", async () => {
  const medidas = [];
  const data = { id: "in_1", amount: 12900, subscription: { id: "sub_1" } };
  assert.equal((await aviso("invoice.paid", data, { applied: true, encontrada: true }, medidas)).http, 200);
  assert.deepEqual(medidas[0], { subscriptionId: "sub_1", tipo: "invoice.paid", pagamento: { chave: "in_1", centavos: 12900 } });
  // fora de ordem só diz respeito ao status: a cobrança foi paga
  await aviso("charge.paid", { id: "ch_1", invoice: { id: "in_1", subscription_id: "sub_1" } }, { applied: false, ignorado: "fora_de_ordem" }, medidas);
  assert.equal(medidas.length, 2);
  await aviso("invoice.paid", data, { applied: false, duplicado: true }, medidas);
  await aviso("invoice.payment_failed", data, { applied: true }, medidas);
  await aviso("invoice.paid", { id: "in_3" }, { applied: true }, medidas); // sem assinatura
  assert.equal(medidas.length, 2);
});

test("webhook: falha da medição não muda a resposta ao Pagar.me", async () => {
  const r = await processarAviso(
    { metodo: "POST", authorization: BASIC, body: { id: "hook_x", type: "invoice.paid", data: { id: "in_1", subscription: { id: "sub_1" } } } },
    { env: WEBHOOK_ENV, aplicarEvento: async () => ({ applied: true }), medirCobranca: async () => { throw new Error("x"); } },
  );
  assert.equal(r.http, 200);
  assert.equal(r.body.ok, true);
});

function dublesDaCobranca(reivindicacao, env = { META_ACCESS_TOKEN: "tok" }) {
  const c = { reivindicar: [], fetch: [], resultado: [] };
  const deps = {
    env,
    fetch: async (url, init) => {
      c.fetch.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: url.includes("graph.facebook.com") ? 200 : 204, json: async () => ({ events_received: 1 }) };
    },
    reivindicar: async (a) => { c.reivindicar.push(a); return reivindicacao; },
    registrarResultado: async (a) => { c.resultado.push(a); },
    agora: () => new Date("2026-11-10T12:00:00Z"),
  };
  return { deps, c };
}

const ENVIAR = {
  encontrada: true, enviar: true, ordem: 1, tenant_id: TENANT, plano: "pro", ciclo: "mensal", com_teste: true,
  email: " Dono@Example.test ", telefone: "+5511987654321", fbp: FBP, fbc: FBC,
};
const ARGS = { subscriptionId: "sub_1", tipo: "invoice.paid", pagamento: { chave: "in_1", centavos: 12900 } };

test("cobrança depois do teste: Purchase com event_id determinístico, valor cobrado e hashes", async () => {
  const { deps, c } = dublesDaCobranca(ENVIAR);
  const r = await medirCobranca(ARGS, deps);
  assert.equal(r.resultado, "enviado");
  assert.equal(r.tipo_compra, "primeira_apos_teste");
  assert.equal(r.meta, "ok_1");
  assert.equal(r.ga4, "sem_secret", "sem GA4_API_SECRET pula o GA4 sem erro");
  assert.deepEqual(c.reivindicar[0], { p_subscription_id: "sub_1", p_chave: "in_1", p_tipo: "invoice.paid" });
  assert.equal(c.fetch.length, 1);
  assert.equal(c.fetch[0].url, "https://graph.facebook.com/v21.0/1753619075655271/events?access_token=tok");
  const [ev] = c.fetch[0].body.data;
  assert.equal(ev.event_name, "Purchase");
  assert.equal(ev.event_id, "nofiscal-purchase-in_1");
  assert.equal(ev.action_source, "system_generated");
  assert.equal(ev.event_time, Math.floor(Date.parse("2026-11-10T12:00:00Z") / 1000));
  assert.equal(ev.event_source_url, undefined);
  assert.deepEqual(ev.custom_data, {
    value: 129, currency: "BRL", order_id: "in_1",
    content_ids: ["nofiscal-pro-mensal"], content_type: "product", content_name: "nó.fiscal Pro",
  });
  assert.deepEqual(ev.user_data, {
    em: [sha("dono@example.test")],
    ph: [sha("5511987654321")],
    external_id: [sha(TENANT)],
    fbp: FBP,
    fbc: FBC,
  });
  assert.deepEqual(c.resultado[0], { p_chave: "in_1", p_meta: "ok_1", p_ga4: "sem_secret" });
});

test("renovação anual com GA4: purchase no Measurement Protocol, transaction_id da fatura", async () => {
  const { deps, c } = dublesDaCobranca(
    { ...ENVIAR, ordem: 2, ciclo: "anual", plano: "inicial", fbp: null, fbc: "lixo" },
    { META_ACCESS_TOKEN: "tok", GA4_API_SECRET: "seg/redo" },
  );
  const r = await medirCobranca({ ...ARGS, pagamento: { chave: "in_7", centavos: null } }, deps);
  assert.equal(r.tipo_compra, "renovacao");
  assert.equal(r.valor_centavos, 47040, "sem valor no aviso: preço do plano anual");
  assert.equal(r.ga4, "ok_204");
  const meta = c.fetch.find((f) => f.url.includes("graph.facebook.com")).body.data[0];
  assert.equal(meta.custom_data.value, 470.4);
  assert.deepEqual(meta.custom_data.content_ids, ["nofiscal-inicial-anual"]);
  assert.equal(meta.user_data.fbp, undefined);
  assert.equal(meta.user_data.fbc, undefined, "fbc fora do formato não sai");
  const ga = c.fetch.find((f) => f.url.includes("google-analytics.com"));
  assert.equal(ga.url, "https://www.google-analytics.com/mp/collect?measurement_id=G-1YEB89RVER&api_secret=seg%2Fredo");
  assert.equal(ga.body.client_id, await clientIdGa4(TENANT));
  assert.match(ga.body.client_id, /^\d+\.\d+$/);
  assert.deepEqual(ga.body.events[0], {
    name: "purchase",
    params: {
      transaction_id: "in_7", value: 470.4, currency: "BRL", plano: "inicial", ciclo: "anual",
      tipo_compra: "renovacao", origem: "webhook",
      items: [{ item_id: "nofiscal-inicial-anual", item_name: "nó.fiscal Inicial", item_category: "nofiscal", price: 470.4, quantity: 1 }],
    },
  });
});

test("nada sai sem assinatura do fiscal, sem consentimento, em repetição ou na cobrança contada no checkout", async () => {
  for (const [rv, esperado] of [
    [null, "nao_fiscal"],
    [{ encontrada: false, enviar: false }, "nao_fiscal"],
    [{ encontrada: true, enviar: false, motivo: "sem_consentimento" }, "sem_consentimento"],
    [{ encontrada: true, enviar: false, motivo: "duplicado" }, "duplicado"],
    [{ encontrada: true, enviar: false, motivo: "contada_no_checkout" }, "contada_no_checkout"],
    [{ ...ENVIAR, plano: "outro" }, "contexto_invalido"],
  ]) {
    const { deps, c } = dublesDaCobranca(rv, { META_ACCESS_TOKEN: "tok", GA4_API_SECRET: "s" });
    assert.equal((await medirCobranca(ARGS, deps)).resultado, esperado);
    assert.equal(c.fetch.length, 0, esperado);
  }
  // fatura de valor zero nem chega a ser reivindicada
  const { deps, c } = dublesDaCobranca(ENVIAR);
  assert.equal((await medirCobranca({ ...ARGS, pagamento: { chave: "in_0", centavos: 0 } }, deps)).resultado, "valor_zero");
  assert.equal(c.reivindicar.length, 0);
});

test("sem META_ACCESS_TOKEN não vai à Meta; GA4_MEASUREMENT_ID troca a propriedade; falha de rede vira resumo", async () => {
  const { deps, c } = dublesDaCobranca(ENVIAR, { GA4_API_SECRET: "s", GA4_MEASUREMENT_ID: "G-TESTE1234" });
  const r = await medirCobranca(ARGS, deps);
  assert.equal(r.meta, "sem_token");
  assert.equal(c.fetch.length, 1);
  assert.ok(c.fetch[0].url.includes("measurement_id=G-TESTE1234"));
  const ruim = dublesDaCobranca(ENVIAR, { GA4_API_SECRET: "s", GA4_MEASUREMENT_ID: "nao-e-ga4" });
  assert.equal((await medirCobranca(ARGS, ruim.deps)).ga4, "measurement_id_invalido");
  assert.equal(await enviarParaGa4(async () => { throw new TypeError("rede"); }, "G-X", "s", {}), "erro_rede");
});

// ------------------------------------------------------------ checkout grava o consentimento

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
const PEDIDO = {
  plano: "pro",
  card_token: "token_x",
  endereco: { cep: "01001000", rua: "Praça da Sé", numero: "1", bairro: "Sé", cidade: "São Paulo", uf: "SP" },
  termos_aceite: true,
  aceite_texto: TEXTO_ACEITE_FISCAL,
};

function checkoutDeps(gravados) {
  return {
    env: ENV,
    sessao: async () => "user-1",
    contexto: async () => ({
      tenant_id: TENANT, cnpj: "11444777000161", razao_social: "E", email: "a@b.test", phone_e164: "+5511987654321",
      trial_ends_at: null, assinatura: null,
    }),
    reivindicarTeste: async () => true,
    registrar: async (l) => ({ id: "assin-1", status: l.status }),
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ id: "sub_1", status: "active", customer: { id: "cus_1" } }) }),
    agora: () => new Date("2026-11-03T15:00:00Z"),
    log: () => {},
    registrarMedicao: async (id, m) => { gravados.push({ id, m }); },
  };
}

test("checkout grava o consentimento na assinatura (fbp/fbc só com granted); falha ao gravar não derruba", async () => {
  const gravados = [];
  const page_url = "https://www.notechstack.com.br/agentes/fiscal/comecar/";
  assert.equal((await processarCheckout({ ...PEDIDO, medicao: { consent: "granted", fbp: FBP, fbc: FBC, page_url } }, checkoutDeps(gravados))).http, 200);
  assert.deepEqual(gravados[0], { id: "assin-1", m: { consent: "granted", fbp: FBP, fbc: FBC, page_url } });
  await processarCheckout({ ...PEDIDO, medicao: { consent: "denied", fbp: FBP } }, checkoutDeps(gravados));
  assert.deepEqual(gravados[1].m, { consent: "denied", fbp: null, fbc: null, page_url: null });
  await processarCheckout({ ...PEDIDO }, checkoutDeps(gravados));
  assert.equal(gravados[2].m.consent, "denied", "sem medicao no corpo: denied");

  const deps = checkoutDeps([]);
  deps.registrarMedicao = async () => { throw new Error("banco"); };
  assert.equal((await processarCheckout({ ...PEDIDO, medicao: { consent: "granted" } }, deps)).http, 200);
});
