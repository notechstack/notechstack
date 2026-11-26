// Tipos de nota por conta (migração 20261123210000): public.fiscal_definir_tipos_nota e nofiscal.tipos_nota_da_conta em
// contas criadas pelas funções do cadastro, no banco local. O checkout grava por aqui; o painel de NF-e lê.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { abrirBancos, criarEmpresa, apagarEmpresa } from "./banco.mjs";

const bancos = abrirBancos();
const criadas = [];
after(async () => {
  for (const e of criadas.reverse()) await apagarEmpresa(bancos.dono, e).catch(() => {});
  await bancos.fechar();
});
const definir = async (tenantId, tipos) =>
  (await bancos.servico.query("select public.fiscal_definir_tipos_nota($1, $2::text[]) as r", [tenantId, tipos])).rows[0].r;
const lidos = async (tenantId) =>
  (await bancos.dono.query("select nofiscal.tipos_nota_da_conta($1) as t", [tenantId])).rows[0].t;
async function conta(plano) {
  const e = await criarEmpresa(bancos.dono, { plano });
  criadas.push(e);
  return e;
}

test("conta-mãe de Escritório: nasce só com NFS-e e aceita NF-e, as duas, em ordem fixa", async () => {
  const e = await conta("escritorio_1000");
  assert.deepEqual(await lidos(e.tenantId), ["nfse"]);
  assert.deepEqual(await definir(e.tenantId, ["nfe"]), { ok: true, tipos_nota: ["nfe"] });
  assert.deepEqual(await lidos(e.tenantId), ["nfe"]);
  assert.deepEqual(await definir(e.tenantId, ["nfe", "nfse"]), { ok: true, tipos_nota: ["nfse", "nfe"] });
  assert.deepEqual(await lidos(e.tenantId), ["nfse", "nfe"]);
  assert.deepEqual((await definir(e.tenantId, ["nfse", "nfse"])).tipos_nota, ["nfse"], "repetido vira um só");
});

test("Inicial e Pro: só NFS-e; pedir NF-e responde SO_ESCRITORIO e nada muda", async () => {
  const e = await conta("pro");
  assert.equal((await definir(e.tenantId, ["nfse", "nfe"])).erro, "SO_ESCRITORIO");
  assert.equal((await definir(e.tenantId, ["nfe"])).erro, "SO_ESCRITORIO");
  assert.deepEqual(await definir(e.tenantId, ["nfse"]), { ok: true, tipos_nota: ["nfse"] });
  assert.deepEqual(await lidos(e.tenantId), ["nfse"]);
});
