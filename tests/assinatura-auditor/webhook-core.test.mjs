import test from "node:test";
import assert from "node:assert/strict";
import { envelopeSeguro, eventoEmDoPayload, mapearEvento } from "../../supabase/functions/assinatura-auditor-webhook/core.ts";

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
