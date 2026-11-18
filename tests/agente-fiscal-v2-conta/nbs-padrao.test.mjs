// NBS padrão por empresa na fiscal-conta (sem banco: o dublê grava o que chega ao configurar).
// `node --test nbs-padrao.test.mjs` roda sozinho; os outros arquivos desta pasta pedem o banco local.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  lerNbsPadrao,
  MSG_NBS_FORA_DA_LISTA,
  MSG_NBS_FORMATO,
  processarConta,
  validarConfiguracao,
} from "../../supabase/functions/fiscal-conta/core.ts";
import { NBS_VALIDAS } from "../../supabase/functions/_shared/fiscal/nbs.ts";

test("lista da edge function é a mesma do motor (rtc/servicos-rtc.ts)", () => {
  const ts = readFileSync(new URL("../../app/api/_lib/rtc/servicos-rtc.ts", import.meta.url), "utf8");
  const motor = JSON.parse(ts.slice(ts.indexOf("= {") + 2).trim()).nbs_validas;
  assert.deepEqual([...NBS_VALIDAS], motor);
  assert.equal(NBS_VALIDAS.size, 918);
});

test("lerNbsPadrao: com ou sem pontos, vazio apaga, fora da lista ou do formato volta com a mensagem", () => {
  assert.deepEqual(lerNbsPadrao("1.1502.10.00"), { ok: true, nbs: "115021000" });
  assert.deepEqual(lerNbsPadrao("115021000"), { ok: true, nbs: "115021000" });
  assert.deepEqual(lerNbsPadrao(""), { ok: true, nbs: null });
  assert.deepEqual(lerNbsPadrao(null), { ok: true, nbs: null });
  assert.deepEqual(lerNbsPadrao("1.1502.10"), { ok: false, mensagem: MSG_NBS_FORMATO });
  assert.deepEqual(lerNbsPadrao(115021000), { ok: false, mensagem: MSG_NBS_FORMATO });
  assert.deepEqual(lerNbsPadrao("123456789"), { ok: false, mensagem: MSG_NBS_FORA_DA_LISTA });
});

test("validarConfiguracao: nbs_padrao só entra nos dados quando vem no pedido", async () => {
  const base = { codigo_servico_nacional: "010101", p_tot_trib_sn: "6" };
  const sem = await validarConfiguracao(base, "pro", null);
  assert.equal(sem.ok, true);
  assert.equal(Object.hasOwn(sem.config.dados, "nbs_padrao"), false);
  const com = await validarConfiguracao({ ...base, nbs_padrao: "1.1502.10.00" }, "inicial", null, "mei");
  assert.deepEqual(com.config.dados, { codigo_servico_nacional: "010101", nbs_padrao: "115021000" });
  const apaga = await validarConfiguracao({ ...base, nbs_padrao: "" }, "pro", null);
  assert.equal(apaga.config.dados.nbs_padrao, null);
  const ruim = await validarConfiguracao({ ...base, nbs_padrao: "123456789" }, "pro", null);
  assert.equal(ruim.ok, false);
  assert.equal(ruim.resultado.http, 422);
  assert.equal(ruim.resultado.body.campo, "nbs_padrao");
});

// Dublê das funções do banco: só o que configurar e empresa_configurar usam.
function deps(gravados) {
  const empresa = { tenant_id: "ab700000-0000-4000-8000-000000000002", regime: "simples" };
  const estado = {
    tenant_id: "ab700000-0000-4000-8000-000000000001", onboarding_etapa: "concluido", plano: "escritorio_5", empresa: { regime: "simples" },
    assinatura: null, certificado: null, fiscal: {},
  };
  return {
    env: {}, fetch: async () => { throw new Error("sem rede"); },
    sessao: async () => "u-1",
    estado: async () => estado,
    escritorio: async () => ({ empresas: [empresa] }),
    configurar: async (_u, dados) => { gravados.push(["conta", dados]); return { ok: true }; },
    empresaConfigurar: async (_u, t, dados) => { gravados.push([t, dados]); return { ok: true }; },
    trocarPlano: async () => ({ ok: true }), agendarCancelamento: async () => ({ status: "ok" }),
    apagarConta: async () => ({ ok: true }),
  };
}

test("configurar (Meus dados) e empresa_configurar (Minhas empresas) levam a NBS ao banco", async () => {
  const gravados = [];
  const d = deps(gravados);
  const r1 = await processarConta("POST", {
    acao: "configurar", codigo_servico_nacional: "010101", p_tot_trib_sn: "6", nbs_padrao: "1.1502.10.00",
  }, d);
  assert.equal(r1.http, 200);
  const r2 = await processarConta("POST", {
    acao: "empresa_configurar", tenant_id: "ab700000-0000-4000-8000-000000000002", codigo_servico_nacional: "010101", p_tot_trib_sn: "6",
    nbs_padrao: "115022000",
  }, d);
  assert.equal(r2.http, 200);
  const r3 = await processarConta("POST", {
    acao: "empresa_configurar", tenant_id: "ab700000-0000-4000-8000-000000000002", codigo_servico_nacional: "010101", p_tot_trib_sn: "6",
  }, d);
  assert.equal(r3.http, 200);
  assert.deepEqual(gravados, [
    ["conta", { codigo_servico_nacional: "010101", p_tot_trib_sn: "6", nbs_padrao: "115021000" }],
    ["ab700000-0000-4000-8000-000000000002", { codigo_servico_nacional: "010101", p_tot_trib_sn: "6", nbs_padrao: "115022000" }],
    ["ab700000-0000-4000-8000-000000000002", { codigo_servico_nacional: "010101", p_tot_trib_sn: "6" }],
  ]);
  const r4 = await processarConta("POST", {
    acao: "empresa_configurar", tenant_id: "ab700000-0000-4000-8000-000000000002", codigo_servico_nacional: "010101", p_tot_trib_sn: "6",
    nbs_padrao: "123456789",
  }, d);
  assert.equal(r4.http, 422);
  assert.equal(r4.body.campo, "nbs_padrao");
  assert.equal(gravados.length, 3);
});
