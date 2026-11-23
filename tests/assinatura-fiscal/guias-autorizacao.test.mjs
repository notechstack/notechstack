// Quem pode ligar/desligar a Guias: a service role exata, ou JWT com role service_role do próprio projeto (o gateway,
// com verify_jwt = true, já conferiu a assinatura). Sem banco.
import test from "node:test";
import assert from "node:assert/strict";
import { autorizadoEquipe, papelDoJwt } from "../../supabase/functions/assinatura-fiscal-guias/core.ts";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.assinatura`;
const REF = "sdeowbqmwkwseyktyemn";

test("aceita a service role exata do ambiente", async () => {
  assert.equal(await autorizadoEquipe("Bearer chave-exata", "chave-exata", REF), true);
});
test("aceita JWT service_role do projeto mesmo diferente da variável", async () => {
  assert.equal(await autorizadoEquipe(`Bearer ${jwt({ role: "service_role", ref: REF })}`, "outra", REF), true);
});
test("recusa anon, authenticated, outro projeto, sem ref e lixo", async () => {
  for (const a of [
    `Bearer ${jwt({ role: "anon", ref: REF })}`,
    `Bearer ${jwt({ role: "authenticated", ref: REF })}`,
    `Bearer ${jwt({ role: "service_role", ref: "outroprojeto" })}`,
    `Bearer ${jwt({ role: "service_role" })}`,
    "Bearer nao-e-jwt", "", null,
  ]) assert.equal(await autorizadoEquipe(a, "outra", REF), false, String(a));
  assert.equal(await autorizadoEquipe(`Bearer ${jwt({ role: "service_role", ref: REF })}`, "outra", ""), false);
});
test("papelDoJwt lê só role e ref", () => {
  assert.deepEqual(papelDoJwt(`Bearer ${jwt({ role: "service_role", ref: REF, x: 1 })}`), { role: "service_role", ref: REF });
  assert.equal(papelDoJwt("Basic abc"), null);
});
