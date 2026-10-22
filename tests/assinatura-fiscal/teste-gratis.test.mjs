// O hash do teste grátis em Deno (Web Crypto) bate com os vetores fixos do lote A
// (app/api/_lib/agente/teste-gratis.test.ts) e com a normalização do Landing.
import test from "node:test";
import assert from "node:assert/strict";
import { hashDoTeste, hashesDoTeste, normalizarParaTeste } from "../../supabase/functions/assinatura-fiscal/teste-gratis.ts";

const SAL = "sal-fixo-do-teste";

test("vetores fixos do lote A", async () => {
  assert.equal(await hashDoTeste("cnpj", "11.444.777/0001-61", SAL), "530a029d1184a46f6d940b425b0a084abcdbf89933ede0a3cbfd1bb3cb6e8972");
  assert.equal(await hashDoTeste("email", " Fulano@Example.TEST ", SAL), "a07d8e63cfa0d2a68cf387d491113bfc2f1a6d6d38b9ab244a7adf60ce9f98de");
  assert.equal(await hashDoTeste("phone", "(11) 98765-4321", SAL), "6887e753951ddbddedc444de4bee15141c233920e5c8ab5a454a89844a3680a0");
  assert.equal(await hashDoTeste("cpf", "123.456.789-09", SAL), "e05ce7666df6ecd848285a0e2a4d69dd3905dca0ce47c84f8da265b7445bfc1c");
  assert.deepEqual(
    await hashesDoTeste({ cnpj: "11.444.777/0001-61", email: "fulano@example.test", phone: "(11) 98765-4321" }, SAL),
    {
      cnpj: "530a029d1184a46f6d940b425b0a084abcdbf89933ede0a3cbfd1bb3cb6e8972",
      email: "a07d8e63cfa0d2a68cf387d491113bfc2f1a6d6d38b9ab244a7adf60ce9f98de",
      phone: "6887e753951ddbddedc444de4bee15141c233920e5c8ab5a454a89844a3680a0",
    },
  );
});

test("normalização e falha fechada", async () => {
  assert.equal(normalizarParaTeste("cpf", "123.456.789-09"), "12345678909");
  assert.equal(normalizarParaTeste("cnpj", "11.444.777/0001-61"), "11444777000161");
  assert.equal(normalizarParaTeste("email", " Fulano@Example.TEST "), "fulano@example.test");
  for (const t of ["(11) 98765-4321", "11987654321", "+55 11 98765-4321", "55 11 98765 4321"]) {
    assert.equal(normalizarParaTeste("phone", t), "+5511987654321", t);
  }
  for (const [tipo, valor] of [["cpf", "1234"], ["cnpj", "123"], ["email", "sem-arroba"], ["phone", "123"]]) {
    assert.throws(() => normalizarParaTeste(tipo, valor), `${tipo} ${valor}`);
  }
  await assert.rejects(hashDoTeste("cnpj", "11444777000161", ""));
  await assert.rejects(hashDoTeste("cnpj", "11444777000161", undefined));
});
