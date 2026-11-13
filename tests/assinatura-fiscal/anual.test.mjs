// Ciclo anual da assinatura (Lucca, 03/11/2026): 12 mensalidades com 20% off, cobradas de uma vez, planos
// anuais próprios no Pagar.me; o anual não aceita cupom e a troca de plano mantém o ciclo (sem banco: dublês).
import test from "node:test";
import assert from "node:assert/strict";
import {
  PLANOS_PAGARME,
  TEXTO_ACEITE_FISCAL,
  centavosAnuais,
  configuracaoPublica,
  corpoDoPlano,
  processarCheckout,
  processarValidarCupom,
} from "../../supabase/functions/assinatura-fiscal/core.ts";
import { estadoPublico, processarConta } from "../../supabase/functions/fiscal-conta/core.ts";
import { criarPlanosFiscal } from "../../scripts/pagarme-assinatura/criar-planos-fiscal.mjs";
import { readFileSync } from "node:fs";

const ENV = {
  PAGARME_ASSINATURA_SECRET_KEY: "sk_test_x",
  PAGARME_ASSINATURA_API_URL: "https://pagarme.simulado/core/v5",
  PAGARME_PLANO_FISCAL_INICIAL_ID: "plan_i",
  PAGARME_PLANO_FISCAL_PRO_ID: "plan_p",
  PAGARME_PLANO_FISCAL_INICIAL_SEM_TESTE_ID: "plan_is",
  PAGARME_PLANO_FISCAL_PRO_SEM_TESTE_ID: "plan_ps",
  PAGARME_PLANO_FISCAL_INICIAL_ANUAL_ID: "plan_ia",
  PAGARME_PLANO_FISCAL_PRO_ANUAL_ID: "plan_pa",
  PAGARME_PLANO_FISCAL_INICIAL_ANUAL_SEM_TESTE_ID: "plan_ias",
  PAGARME_PLANO_FISCAL_PRO_ANUAL_SEM_TESTE_ID: "plan_pas",
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
  ciclo: "anual",
  card_token: "token_x",
  endereco: { cep: "01001000", rua: "Praça da Sé", numero: "1", bairro: "Sé", cidade: "São Paulo", uf: "SP" },
  termos_aceite: true,
  aceite_texto: TEXTO_ACEITE_FISCAL,
};

function dubles({ env = {}, comTeste = true } = {}) {
  const c = { fetch: [], registrar: [], cupom: [] };
  const deps = {
    env: { ...ENV, ...env },
    sessao: async () => "user-1",
    contexto: async () => CONTEXTO,
    reivindicarTeste: async () => comTeste,
    registrar: async (l) => { c.registrar.push(l); return { id: "a1", status: l.status }; },
    validarCupom: async (...a) => { c.cupom.push(a); return { ok: true, codigo: "DEZ", tipo: "percentual", valor: 10 }; },
    fetch: async (url, init = {}) => {
      c.fetch.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
      return { ok: true, status: 200, json: async () => ({ id: "sub_1", status: "future", customer: { id: "cus_1" } }) };
    },
    log: () => {},
  };
  return { deps, c };
}

test("preço anual: 12 mensalidades com 20% off (R$ 470,40 e R$ 1.238,40)", () => {
  assert.equal(centavosAnuais(4900), 47040);
  assert.equal(centavosAnuais(12900), 123840);
  for (const codigo of ["inicial_anual", "inicial_anual_sem_teste"]) assert.equal(PLANOS_PAGARME[codigo].centavos, 47040);
  for (const codigo of ["pro_anual", "pro_anual_sem_teste"]) assert.equal(PLANOS_PAGARME[codigo].centavos, 123840);
});

test("planos anuais no Pagar.me: interval year, preço do ano e teste só no par com teste", () => {
  const com = corpoDoPlano("pro_anual");
  assert.equal(com.interval, "year");
  assert.equal(com.interval_count, 1);
  assert.equal(com.trial_period_days, 7);
  assert.equal(com.name, "Agente Fiscal Pro anual");
  assert.equal(com.items[0].pricing_scheme.price, 123840);
  const sem = corpoDoPlano("inicial_anual_sem_teste");
  assert.equal(sem.interval, "year");
  assert.equal("trial_period_days" in sem, false);
  assert.equal(sem.name, "Agente Fiscal Inicial anual (sem teste)");
  // O mensal não muda.
  assert.equal(corpoDoPlano("pro").interval, "month");
  assert.equal(corpoDoPlano("pro").name, "Agente Fiscal Pro");
  assert.equal(corpoDoPlano("pro").items[0].pricing_scheme.price, 12900);
});

test("configuração pública: anual_disponivel só com os quatro planos anuais", () => {
  const c = configuracaoPublica(ENV);
  assert.equal(c.anual_disponivel, true);
  assert.deepEqual(c.planos, {
    inicial: { valor_centavos: 4900, anual_centavos: 47040 },
    pro: { valor_centavos: 12900, anual_centavos: 123840 },
    // Escritório: empresas e notas da faixa; anual desde 13/11/2026 (25%, 30% e 45% OFF).
    escritorio_5: { valor_centavos: 29700, anual_centavos: 267300, empresas: 5, notas: 500 },
    escritorio_20: { valor_centavos: 79700, anual_centavos: 669480, empresas: 20, notas: 2000 },
    escritorio_50: { valor_centavos: 149700, anual_centavos: 988020, empresas: 50, notas: 5000 },
  });
  assert.equal(configuracaoPublica({ ...ENV, PAGARME_PLANO_FISCAL_PRO_ANUAL_SEM_TESTE_ID: "" }).anual_disponivel, false);
});

test("checkout anual usa o plano anual (com e sem teste), registra o ciclo e mede o valor do ano", async () => {
  for (const [comTeste, planId, evento] of [[true, "plan_pa", "StartTrial"], [false, "plan_pas", "Purchase"]]) {
    const { deps, c } = dubles({ comTeste });
    const r = await processarCheckout({ ...PEDIDO, confirmar_sem_teste: !comTeste || undefined }, deps);
    assert.equal(r.http, 200, JSON.stringify(r.body));
    assert.equal(c.fetch[0].body.plan_id, planId);
    assert.equal(c.fetch[0].body.metadata.ciclo, "anual");
    assert.equal(c.registrar[0].ciclo, "anual");
    assert.equal(r.body.ciclo, "anual");
    assert.equal(r.body.medicao.evento, evento);
    assert.equal(r.body.medicao.valor, 1238.4);
  }
  const { deps, c } = dubles();
  await processarCheckout({ ...PEDIDO, plano: "inicial" }, deps);
  assert.equal(c.fetch[0].body.plan_id, "plan_ia");
});

test("anual sem teste: pede confirmação antes de cobrar o ano, sem chamar o Pagar.me", async () => {
  const { deps, c } = dubles({ comTeste: false });
  const r = await processarCheckout(PEDIDO, deps);
  assert.equal(r.http, 409);
  assert.equal(r.body.error_code, "CONFIRMAR_SEM_TESTE");
  assert.equal(r.body.valor_centavos, 123840);
  assert.equal(c.fetch.length + c.registrar.length, 0);
  // O mensal sem teste segue como antes (cobra e avisa).
  const m = dubles({ comTeste: false });
  assert.equal((await processarCheckout({ ...PEDIDO, ciclo: "mensal" }, m.deps)).http, 200);
  assert.equal(m.c.fetch[0].body.plan_id, "plan_ps");
});

test("edge function lê do ambiente os ids de todos os planos", () => {
  const index = readFileSync(new URL("../../supabase/functions/assinatura-fiscal/index.ts", import.meta.url), "utf8");
  const nomes = index.slice(index.indexOf("const NOMES_ENV"), index.indexOf("];", index.indexOf("const NOMES_ENV")));
  for (const p of Object.values(PLANOS_PAGARME)) assert.ok(nomes.includes(`"${p.env}"`), p.env);
});

test("sem ciclo ou com mensal, o checkout segue o mensal de antes", async () => {
  for (const ciclo of [undefined, "mensal"]) {
    const { deps, c } = dubles();
    const r = await processarCheckout({ ...PEDIDO, ciclo }, deps);
    assert.equal(r.http, 200);
    assert.equal(c.fetch[0].body.plan_id, "plan_p");
    assert.equal(c.registrar[0].ciclo, "mensal");
    assert.equal(r.body.medicao.valor, 129);
  }
});

test("ciclo inválido → 400; anual sem os planos anuais → PLANO_INDISPONIVEL; nada chega ao Pagar.me", async () => {
  {
    const { deps, c } = dubles();
    const r = await processarCheckout({ ...PEDIDO, ciclo: "semestral" }, deps);
    assert.equal(r.http, 400);
    assert.equal(c.fetch.length, 0);
  }
  {
    const { deps, c } = dubles({ env: { PAGARME_PLANO_FISCAL_PRO_ANUAL_SEM_TESTE_ID: "" } });
    const r = await processarCheckout(PEDIDO, deps);
    assert.equal(r.http, 409);
    assert.equal(r.body.error_code, "PLANO_INDISPONIVEL");
    assert.equal(c.fetch.length, 0);
  }
});

test("anual não aceita cupom: no checkout e na prévia, sem consultar o banco", async () => {
  {
    const { deps, c } = dubles();
    const r = await processarCheckout({ ...PEDIDO, cupom: "DEZ" }, deps);
    assert.equal(r.http, 422);
    assert.equal(r.body.error_code, "CUPOM_ANUAL");
    assert.equal(c.fetch.length + c.cupom.length + c.registrar.length, 0);
  }
  {
    const { deps, c } = dubles();
    const r = await processarValidarCupom({ acao: "validar_cupom", codigo: "DEZ", plano: "pro", ciclo: "anual" }, deps);
    assert.equal(r.body.error_code, "CUPOM_ANUAL");
    assert.equal(c.cupom.length, 0);
  }
  // No mensal o cupom continua valendo.
  const { deps } = dubles();
  const r = await processarValidarCupom({ acao: "validar_cupom", codigo: "DEZ", plano: "pro" }, deps);
  assert.equal(r.http, 200, JSON.stringify(r.body));
  assert.equal(r.body.cupom.valor_centavos_com_desconto, 11610);
});

function estadoBanco(ciclo) {
  return {
    tenant_id: CONTEXTO.tenant_id,
    onboarding_etapa: "concluido",
    plano: "inicial",
    empresa: {},
    assinatura: {
      id: "s1", status: "paga", com_teste: false, em_teste: false, trial_ends_at: null,
      cancelamento_agendado_para: null, cancelamento_origem: null, pagarme_subscription_id: "sub_1",
      periodo_fim: null, ...(ciclo === undefined ? {} : { ciclo }),
    },
    certificado: null,
    fiscal: {},
  };
}

async function trocar(ciclo) {
  const chamadas = [];
  let estado = estadoBanco(ciclo);
  const deps = {
    env: ENV,
    sessao: async () => "user-1",
    estado: async () => estado,
    configurar: async () => ({ ok: true }),
    trocarPlano: async (_u, plano) => { estado = { ...estado, plano }; return { ok: true }; },
    agendarCancelamento: async () => ({ status: "paga" }),
    apagarConta: async () => ({ ok: true }),
    fetch: async (url, init = {}) => {
      chamadas.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
      const json = init.method === "GET" ? { data: [{ id: "si_1", status: "active" }] } : { id: "si_1" };
      return { ok: true, status: 200, json: async () => json };
    },
    log: () => {},
  };
  const r = await processarConta("POST", { acao: "trocar_plano", plano: "pro" }, deps);
  return { r, put: chamadas.find((c) => c.method === "PUT") };
}

test("troca de plano no anual fica com a equipe (409, sem Pagar.me); no mensal segue igual", async () => {
  const anual = await trocar("anual");
  assert.equal(anual.r.http, 409);
  assert.equal(anual.r.body.error_code, "TROCA_ANUAL_INDISPONIVEL");
  assert.equal(anual.put, undefined);
  for (const ciclo of ["mensal", undefined]) {
    const m = await trocar(ciclo);
    assert.deepEqual(m.put.body.pricing_scheme, { scheme_type: "unit", price: 12900 }, String(ciclo));
    assert.equal(m.put.body.name, "Agente Fiscal Pro");
  }
});

test("estado público leva o ciclo da assinatura (ausente é mensal)", () => {
  assert.equal(estadoPublico(estadoBanco("anual")).assinatura.ciclo, "anual");
  assert.equal(estadoPublico(estadoBanco(undefined)).assinatura.ciclo, "mensal");
});

test("script de planos cria só os códigos pedidos (os mensais já existem em produção)", async () => {
  const criados = [];
  const fetch = async (_url, init) => {
    const corpo = JSON.parse(init.body);
    criados.push(corpo.metadata.codigo);
    return { ok: true, status: 200, json: async () => ({ id: `plan_${corpo.metadata.codigo}` }) };
  };
  const env = { PAGARME_SECRET_KEY: "sk_live" };
  const anuais = ["inicial_anual", "pro_anual", "inicial_anual_sem_teste", "pro_anual_sem_teste"];
  const lista = await criarPlanosFiscal({ fetch, env, codigos: anuais });
  assert.deepEqual(criados, anuais);
  assert.deepEqual(lista.map((p) => p.env), [
    "PAGARME_PLANO_FISCAL_INICIAL_ANUAL_ID",
    "PAGARME_PLANO_FISCAL_PRO_ANUAL_ID",
    "PAGARME_PLANO_FISCAL_INICIAL_ANUAL_SEM_TESTE_ID",
    "PAGARME_PLANO_FISCAL_PRO_ANUAL_SEM_TESTE_ID",
  ]);
  await assert.rejects(criarPlanosFiscal({ fetch, env, codigos: ["anual"] }), /PLANO_DESCONHECIDO/);
});
