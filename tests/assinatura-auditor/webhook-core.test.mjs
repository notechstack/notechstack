import test from "node:test";
import assert from "node:assert/strict";
import { envelopeSeguro, mapearEvento } from "../../supabase/functions/assinatura-auditor-webhook/core.ts";

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
