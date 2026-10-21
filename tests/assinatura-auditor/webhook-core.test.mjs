import test from "node:test";
import assert from "node:assert/strict";
import { envelopeSeguro, eventoEmDoPayload, mapearEvento, PLANOS_AUDITOR, planosDoEvento, triarEvento } from "../../supabase/functions/assinatura-auditor-webhook/core.ts";
import { PLANOS } from "../../supabase/functions/assinatura-auditor/core.ts";

test("created_at do topo do payload -> ISO em UTC; invalido ou ausente -> null", () => {
  assert.equal(eventoEmDoPayload({ id: "hook_1", created_at: "2026-10-16T12:34:56Z" }), "2026-10-16T12:34:56.000Z");
  assert.equal(eventoEmDoPayload({ created_at: "2026-10-16T12:34:56.5935744Z" }), "2026-10-16T12:34:56.593Z");
  assert.equal(eventoEmDoPayload({ created_at: "2026-10-16T09:34:56-03:00" }), "2026-10-16T12:34:56.000Z");
  assert.equal(eventoEmDoPayload({ created_at: " 2026-10-16T12:34:56 " }), "2026-10-16T12:34:56.000Z"); // sem fuso: UTC
  for (const ruim of [undefined, null, "", "ontem", "2026-10-16", "16/10/2026 12:00", "2026-13-40T99:00:00Z", 1760618096000, {}]) {
    assert.equal(eventoEmDoPayload({ created_at: ruim }), null, `aceitou ${JSON.stringify(ruim)}`);
  }
  assert.equal(eventoEmDoPayload(null), null);
  // so o topo: created_at dentro de data nao conta
  assert.equal(eventoEmDoPayload({ data: { created_at: "2026-10-16T12:34:56Z" } }), null);
});

test("invoice.paid e charge.paid -> paga", () => {
  assert.equal(mapearEvento("invoice.paid", { subscription: { id: "sub_1" } }).status, "paga");
  assert.equal(mapearEvento("charge.paid", { invoice: { subscription_id: "sub_1" } }).status, "paga");
});

test("falhas de pagamento -> recusada", () => {
  assert.equal(mapearEvento("charge.payment_failed", {}).status, "recusada");
  assert.equal(mapearEvento("invoice.payment_failed", {}).status, "recusada");
  assert.equal(mapearEvento("subscription.payment_failed", {}).status, "recusada");
});

test("subscription.canceled -> cancelada", () => {
  const r = mapearEvento("subscription.canceled", { id: "sub_9", status: "canceled" });
  assert.deepEqual(r, { subscriptionId: "sub_9", status: "cancelada" });
});

test("outros tipos -> status null", () => {
  assert.equal(mapearEvento("subscription.created", { id: "sub_1" }).status, null);
  assert.equal(mapearEvento("invoice.created", {}).status, null);
});

test("id da assinatura nos formatos do contrato, na ordem", () => {
  assert.equal(mapearEvento("invoice.paid", { subscription: { id: "a" }, subscription_id: "b" }).subscriptionId, "a");
  assert.equal(mapearEvento("invoice.paid", { subscription_id: "b", invoice: { subscription: { id: "c" } } }).subscriptionId, "b");
  assert.equal(mapearEvento("charge.paid", { invoice: { subscription: { id: "c" }, subscription_id: "d" } }).subscriptionId, "c");
  assert.equal(mapearEvento("charge.paid", { invoice: { subscription_id: "d" } }).subscriptionId, "d");
  assert.equal(mapearEvento("subscription.created", { id: "e" }).subscriptionId, "e");
  // data.id so vale para subscription.*: num invoice.paid o data.id e da fatura
  assert.equal(mapearEvento("invoice.paid", { id: "in_1" }).subscriptionId, null);
});

test("envelope sem e-mail, documento, telefone ou cartao", () => {
  const data = {
    id: "ch_1",
    status: "failed",
    customer: { id: "cus_1", email: "pessoa@exemplo.com", document: "12345678909", phones: { mobile_phone: { number: "999999999" } } },
    invoice: { id: "in_1", status: "failed", subscription: { id: "sub_1" } },
    last_transaction: { card: { last_four_digits: "1111", holder_name: "PESSOA" } },
    card: { first_six_digits: "411111" },
  };
  const env = envelopeSeguro("hook_1", "charge.payment_failed", data);
  const s = JSON.stringify(env);
  for (const proibido of ["pessoa@exemplo.com", "12345678909", "999999999", "1111", "PESSOA", "411111", "email", "document", "phone", "card"]) {
    assert.equal(s.includes(proibido), false, `vazou: ${proibido}`);
  }
  assert.equal(env.id, "hook_1");
  assert.equal(env.type, "charge.payment_failed");
  assert.equal(env.data.subscription_id, "sub_1");
  assert.equal(env.data.charge_id, "ch_1");
  assert.equal(env.data.customer_id, "cus_1");
  assert.equal(env.status_aplicado, "recusada");
});

// ── Só eventos do auditor (21/10): o Pagar.me manda para todos os webhooks cadastrados ──
const NOSSOS = ["plan_mensal", "plan_semanal", "plan_agencia"];

test("os nomes dos secrets de plano são os mesmos do checkout", () => {
  assert.deepEqual([...PLANOS_AUDITOR].sort(), Object.values(PLANOS).map((p) => p.env).sort());
});

test("metadata origem=auditor, em qualquer lugar do payload, marca o evento como do auditor", () => {
  for (const data of [
    { id: "sub_1", metadata: { origem: "auditor", plano: "semanal" } },
    { subscription: { id: "sub_1", metadata: { origem: "auditor" } } },
    { invoice: { id: "in_1", metadata: { origem: "auditor" } } },
    { invoice: { subscription: { id: "sub_1", metadata: { origem: "auditor" } } } },
  ]) {
    assert.deepEqual(triarEvento("invoice.paid", data, NOSSOS), { decisao: "auditor", sinal: "metadata" }, JSON.stringify(data));
  }
});

test("plan_id de um plano do auditor marca o evento como do auditor", () => {
  assert.deepEqual(triarEvento("subscription.canceled", { id: "sub_2", plan: { id: "plan_semanal" } }, NOSSOS), { decisao: "auditor", sinal: "plano" });
  assert.deepEqual(triarEvento("invoice.paid", { subscription: { id: "sub_2", plan_id: "plan_agencia" } }, NOSSOS), { decisao: "auditor", sinal: "plano" });
  assert.deepEqual(planosDoEvento({ plan_id: "a", subscription: { plan: { id: "b" } }, invoice: { subscription: { plan_id: "c" } } }).sort(), ["a", "b", "c"]);
});

test("cobrança avulsa do Roteador ou de teste (sem assinatura, sem metadata, sem plano) → ignorar", () => {
  const roteador = {
    id: "ch_roteador", status: "paid", amount: 19700, metadata: { origem: "roteador" },
    customer: { id: "cus_x", email: "pessoa@exemplo.com", document: "12345678909" },
  };
  assert.deepEqual(triarEvento("charge.paid", roteador, NOSSOS), { decisao: "ignorar" });
  assert.deepEqual(triarEvento("order.paid", { id: "or_1" }, NOSSOS), { decisao: "ignorar" });
  // sem planos configurados (secrets ausentes) a regra continua valendo: ignora em vez de aceitar tudo
  assert.deepEqual(triarEvento("charge.paid", roteador, ["", ""]), { decisao: "ignorar" });
});

test("assinatura de outro produto, com plano que não é do auditor → só segue se o banco conhecer o id", () => {
  assert.deepEqual(triarEvento("invoice.paid", { subscription: { id: "sub_outro", plan: { id: "plan_roteador" } } }, NOSSOS),
    { decisao: "consultar", subscriptionId: "sub_outro" });
});
