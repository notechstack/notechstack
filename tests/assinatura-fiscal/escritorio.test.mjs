// Plano Escritório na assinatura (Lucca, 05/11/2026; .design/agente-fiscal-escritorio.md): faixas escritorio_5/20/50,
// só mensal, três planos por faixa no Pagar.me (teste de 7 dias, sem teste e teste de 30 dias do cupom de fundador).
// Sem banco: dependências em dublê (as regras do cupom ficam em nofiscal.cupom_avaliar, migração 20261105180000).
import test from "node:test";
import assert from "node:assert/strict";
import {
  PLANOS_PAGARME,
  TEXTO_ACEITE_FISCAL,
  centavosDoCiclo,
  configuracaoPublica,
  corpoDoPlano,
  processarCheckout,
  processarValidarCupom,
} from "../../supabase/functions/assinatura-fiscal/core.ts";
import { medirCobranca } from "../../supabase/functions/assinatura-fiscal-webhook/compra.ts";
import { criarPlanosFiscal } from "../../scripts/pagarme-assinatura/criar-planos-fiscal.mjs";

const AGORA = new Date("2026-11-05T15:00:00Z");
const DIA = 24 * 3600 * 1000;

const ENV_ESCRITORIO = Object.fromEntries(
  ["5", "20", "50"].flatMap((f) => [
    [`PAGARME_PLANO_FISCAL_ESCRITORIO_${f}_ID`, `plan_e${f}`],
    [`PAGARME_PLANO_FISCAL_ESCRITORIO_${f}_SEM_TESTE_ID`, `plan_e${f}s`],
    [`PAGARME_PLANO_FISCAL_ESCRITORIO_${f}_TESTE30_ID`, `plan_e${f}t30`],
    [`PAGARME_PLANO_FISCAL_ESCRITORIO_${f}_ANUAL_ID`, `plan_e${f}a`],
    [`PAGARME_PLANO_FISCAL_ESCRITORIO_${f}_ANUAL_SEM_TESTE_ID`, `plan_e${f}as`],
  ]),
);
const ENV = {
  PAGARME_ASSINATURA_SECRET_KEY: "sk_test_x",
  PAGARME_ASSINATURA_API_URL: "https://pagarme.simulado/core/v5",
  PAGARME_PLANO_FISCAL_INICIAL_ID: "plan_i",
  PAGARME_PLANO_FISCAL_PRO_ID: "plan_p",
  PAGARME_PLANO_FISCAL_INICIAL_SEM_TESTE_ID: "plan_is",
  PAGARME_PLANO_FISCAL_PRO_SEM_TESTE_ID: "plan_ps",
  ...ENV_ESCRITORIO,
  FISCAL_VENDA_ABERTA: "sim",
  FISCAL_TRIAL_SALT: "sal",
};
const CONTEXTO = {
  tenant_id: "00000000-0000-4000-8000-000000000005",
  cnpj: "11444777000161",
  razao_social: "Escritório Contábil Teste",
  email: "sandra@example.test",
  phone_e164: "+5511987654321",
  trial_ends_at: null,
  assinatura: null,
};
const PEDIDO = {
  plano: "escritorio_5",
  card_token: "token_x",
  endereco: { cep: "01001000", rua: "Praça da Sé", numero: "1", bairro: "Sé", cidade: "São Paulo", uf: "SP" },
  termos_aceite: true,
  aceite_texto: TEXTO_ACEITE_FISCAL,
};
// O que nofiscal.cupom_avaliar devolve para o FUNDADOR5 (scripts/pagarme-assinatura/cupons-fundador-escritorio.sql).
const FUNDADOR5 = {
  ok: true, codigo: "FUNDADOR5", descricao: "Fundador: 1º mês grátis e R$ 247/mês no 1º ano",
  tipo: "valor", valor: 5000, cortesia: false, ciclos: 12, dias_de_teste: 30,
};

function dubles({ env = {}, testeLiberado = true, cupom = FUNDADOR5 } = {}) {
  const c = { fetch: [], reivindicar: [], registrar: [], cupom: [], usar: [] };
  const deps = {
    env: { ...ENV, ...env },
    agora: () => AGORA,
    sessao: async () => "user-1",
    contexto: async () => CONTEXTO,
    reivindicarTeste: async (t, h) => { c.reivindicar.push(h); return testeLiberado; },
    registrar: async (l) => { c.registrar.push(l); return { id: "assin-e1", status: l.status }; },
    validarCupom: async (...a) => { c.cupom.push(a); return cupom; },
    usarCupom: async (...a) => { c.usar.push(a); return { ok: true }; },
    fetch: async (url, init = {}) => {
      c.fetch.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
      return { ok: true, status: 200, json: async () => ({ id: "sub_e1", status: "future", customer: { id: "cus_1" } }) };
    },
    log: () => {},
  };
  return { deps, c };
}

test("planos do Escritório no Pagar.me: 9 códigos, mensais, NOFISCAL, teste de 7, nenhum e 30 dias", () => {
  const precos = { escritorio_5: 29700, escritorio_20: 79700, escritorio_50: 149700 };
  for (const [faixa, centavos] of Object.entries(precos)) {
    const n = faixa.split("_")[1];
    const base = corpoDoPlano(faixa);
    const sem = corpoDoPlano(`${faixa}_sem_teste`);
    const trinta = corpoDoPlano(`${faixa}_teste30`);
    for (const p of [base, sem, trinta]) {
      assert.equal(p.interval, "month", faixa);
      assert.equal(p.statement_descriptor, "NOFISCAL");
      assert.equal(p.items[0].pricing_scheme.price, centavos);
    }
    assert.equal(base.name, `Agente Fiscal Escritório ${n}`);
    assert.equal(base.trial_period_days, 7);
    assert.equal(sem.name, `Agente Fiscal Escritório ${n} (sem teste)`);
    assert.equal("trial_period_days" in sem, false, "sem teste: trial 0, sem o campo, como Inicial e Pro");
    assert.equal(trinta.name, `Agente Fiscal Escritório ${n} (teste de 30 dias)`);
    assert.equal(trinta.trial_period_days, 30);
    assert.equal(PLANOS_PAGARME[faixa].env, `PAGARME_PLANO_FISCAL_ESCRITORIO_${n}_ID`);
    assert.equal(PLANOS_PAGARME[`${faixa}_sem_teste`].env, `PAGARME_PLANO_FISCAL_ESCRITORIO_${n}_SEM_TESTE_ID`);
    assert.equal(PLANOS_PAGARME[`${faixa}_teste30`].env, `PAGARME_PLANO_FISCAL_ESCRITORIO_${n}_TESTE30_ID`);
    assert.equal(centavosDoCiclo(faixa, "mensal"), centavos);
  }
  // Inicial e Pro não mudam.
  assert.equal(corpoDoPlano("pro").name, "Agente Fiscal Pro");
  assert.equal(corpoDoPlano("inicial_sem_teste").name, "Agente Fiscal Inicial (sem teste)");
});

test("configuração pública: as 3 faixas com preço, empresas e notas; escritorio_disponivel só com os 9 planos", () => {
  const c = configuracaoPublica(ENV);
  assert.equal(c.escritorio_disponivel, true);
  assert.deepEqual(c.planos.escritorio_5, { valor_centavos: 29700, anual_centavos: 267300, empresas: 5, notas: 500 });
  assert.deepEqual(c.planos.escritorio_20, { valor_centavos: 79700, anual_centavos: 669480, empresas: 20, notas: 2000 });
  assert.deepEqual(c.planos.escritorio_50, { valor_centavos: 149700, anual_centavos: 988020, empresas: 50, notas: 5000 });
  assert.equal(configuracaoPublica({ ...ENV, PAGARME_PLANO_FISCAL_ESCRITORIO_50_TESTE30_ID: "" }).escritorio_disponivel, false);
  assert.doesNotMatch(JSON.stringify(c), /plan_|sk_test|sal/);
});

test("FUNDADOR5: plano _teste30, trial de 30 dias, desconto em discounts e StartTrial de R$ 247", async () => {
  // Mesmo com o teste de 7 dias já usado, o cupom de fundador dá os 30 dias.
  for (const testeLiberado of [true, false]) {
    const { deps, c } = dubles({ testeLiberado });
    const r = await processarCheckout({ ...PEDIDO, cupom: "fundador5" }, deps);
    assert.equal(r.http, 200, JSON.stringify(r.body));
    const corpo = c.fetch[0].body;
    assert.equal(corpo.plan_id, "plan_e5t30", `teste liberado: ${testeLiberado}`);
    assert.deepEqual(corpo.discounts, [{ value: 5000, discount_type: "flat", cycles: 12 }]);
    assert.equal(corpo.metadata.plano, "escritorio_5");
    assert.equal(corpo.metadata.dias_de_teste, 30);
    assert.equal(corpo.metadata.cupom, "FUNDADOR5");
    assert.deepEqual(c.cupom[0], [CONTEXTO.tenant_id, "FUNDADOR5", "escritorio_5"]);
    assert.equal(c.reivindicar.length, 1, "a reivindicação marca CNPJ, e-mail e telefone como já testados");
    const linha = c.registrar[0];
    assert.equal(linha.plano, "escritorio_5");
    assert.equal(linha.ciclo, "mensal");
    assert.equal(linha.com_teste, true);
    assert.equal(linha.trial_ends_at, new Date(AGORA.getTime() + 30 * DIA).toISOString());
    assert.equal(r.body.com_teste, true);
    assert.equal(r.body.dias_de_teste, 30);
    assert.equal(r.body.aviso, undefined);
    assert.deepEqual(r.body.medicao, {
      evento: "StartTrial", event_id: "nofiscal-trial-assin-e1", transaction_id: "assin-e1", valor: 247, moeda: "BRL",
    });
    assert.equal(r.body.cupom.valor_centavos_com_desconto, 24700);
    assert.deepEqual(c.usar[0], [CONTEXTO.tenant_id, "FUNDADOR5", "escritorio_5", "sub_e1"]);
  }
});

test("Escritório sem cupom: teste de 7 dias liberado → plano base; teste já usado → _sem_teste e Purchase pelo preço da faixa", async () => {
  const liberado = dubles({ testeLiberado: true });
  const r1 = await processarCheckout(PEDIDO, liberado.deps);
  assert.equal(r1.http, 200, JSON.stringify(r1.body));
  assert.equal(liberado.c.fetch[0].body.plan_id, "plan_e5");
  assert.equal(liberado.c.fetch[0].body.discounts, undefined);
  assert.equal(liberado.c.fetch[0].body.metadata.dias_de_teste, undefined);
  assert.equal(liberado.c.registrar[0].trial_ends_at, new Date(AGORA.getTime() + 7 * DIA).toISOString());
  assert.equal(r1.body.medicao.evento, "StartTrial");
  assert.equal(r1.body.medicao.valor, 297);

  const usado = dubles({ testeLiberado: false });
  const r2 = await processarCheckout({ ...PEDIDO, plano: "escritorio_20" }, usado.deps);
  assert.equal(r2.http, 200, JSON.stringify(r2.body));
  assert.equal(usado.c.fetch[0].body.plan_id, "plan_e20s");
  assert.equal(usado.c.registrar[0].com_teste, false);
  assert.equal(usado.c.registrar[0].trial_ends_at, null);
  assert.equal(usado.c.registrar[0].plano, "escritorio_20");
  assert.equal(r2.body.com_teste, false);
  assert.match(r2.body.aviso, /já usou o teste grátis/);
  assert.equal(r2.body.medicao.evento, "Purchase");
  assert.equal(r2.body.medicao.valor, 797);
});

test("cupom sem dias_de_teste no Escritório segue a regra do teste de 7 dias, com o desconto", async () => {
  const { deps, c } = dubles({
    testeLiberado: false,
    cupom: { ok: true, codigo: "DEZ", tipo: "percentual", valor: 10, cortesia: false, ciclos: 3, dias_de_teste: null },
  });
  const r = await processarCheckout({ ...PEDIDO, plano: "escritorio_50", cupom: "DEZ" }, deps);
  assert.equal(r.http, 200, JSON.stringify(r.body));
  assert.equal(c.fetch[0].body.plan_id, "plan_e50s");
  assert.deepEqual(c.fetch[0].body.discounts, [{ value: 10, discount_type: "percentage", cycles: 3 }]);
  assert.equal(r.body.medicao.valor, 1347.3);
});

test("Escritório anual (13/11/2026): plano anual da faixa, valor do ano com 25%, 30% e 45% OFF; cupom só no mensal", async () => {
  for (const [faixa, f, ano] of [["escritorio_5", "5", 267300], ["escritorio_20", "20", 669480], ["escritorio_50", "50", 988020]]) {
    assert.equal(centavosDoCiclo(faixa, "anual"), ano, faixa);
    for (const [comTeste, plan] of [[true, `plan_e${f}a`], [false, `plan_e${f}as`]]) {
      const { deps, c } = dubles({ testeLiberado: comTeste });
      const r = await processarCheckout({ ...PEDIDO, plano: faixa, ciclo: "anual", confirmar_sem_teste: !comTeste || undefined }, deps);
      assert.equal(r.http, 200, JSON.stringify(r.body));
      assert.equal(c.fetch[0].body.plan_id, plan, `${faixa} com teste: ${comTeste}`);
      assert.equal(r.body.medicao.valor, ano / 100);
    }
  }
  // sem teste, o anual pede a confirmação antes de cobrar o ano
  const { deps: d0, c: c0 } = dubles({ testeLiberado: false });
  const sem = await processarCheckout({ ...PEDIDO, ciclo: "anual" }, d0);
  assert.equal(sem.body.error_code, "CONFIRMAR_SEM_TESTE");
  assert.equal(sem.body.valor_centavos, 267300);
  assert.equal(c0.fetch.length, 0);
  // cupom (fundador inclusive) não vale no anual, nem na prévia
  const { deps, c } = dubles();
  const r = await processarCheckout({ ...PEDIDO, ciclo: "anual", cupom: "FUNDADOR5" }, deps);
  assert.equal(r.body.error_code, "CUPOM_ANUAL");
  assert.equal(c.fetch.length + c.registrar.length, 0);
  const p = await processarValidarCupom({ acao: "validar_cupom", codigo: "FUNDADOR5", plano: "escritorio_5", ciclo: "anual" }, deps);
  assert.equal(p.body.error_code, "CUPOM_ANUAL");
  // sem os ids anuais da faixa, o anual fica indisponível e o mensal segue
  const semAnual = { ...ENV, PAGARME_PLANO_FISCAL_ESCRITORIO_5_ANUAL_SEM_TESTE_ID: "" };
  const { deps: d1 } = dubles({ env: semAnual });
  assert.equal((await processarCheckout({ ...PEDIDO, ciclo: "anual" }, d1)).body.error_code, "PLANO_INDISPONIVEL");
  const { deps: d2 } = dubles({ env: semAnual });
  assert.equal((await processarCheckout({ ...PEDIDO }, d2)).http, 200);
  assert.equal(configuracaoPublica(semAnual).escritorio_anual_disponivel, false);
  assert.equal(configuracaoPublica(semAnual).escritorio_disponivel, true);
  assert.equal(configuracaoPublica(ENV).escritorio_anual_disponivel, true);
});

test("prévia com FUNDADOR5: R$ 297 vira R$ 247 por 12 ciclos, com 30 dias de teste", async () => {
  const { deps, c } = dubles();
  const r = await processarValidarCupom({ acao: "validar_cupom", codigo: "fundador5", plano: "escritorio_5" }, deps);
  assert.equal(r.http, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.cupom, {
    codigo: "FUNDADOR5", descricao: "Fundador: 1º mês grátis e R$ 247/mês no 1º ano", tipo: "valor", valor: 5000,
    cortesia: false, ciclos: 12, valor_centavos: 29700, valor_centavos_com_desconto: 24700, dias_de_teste: 30,
  });
  assert.deepEqual(c.cupom[0], [CONTEXTO.tenant_id, "FUNDADOR5", "escritorio_5"]);
});

test("cupom de 30 dias em Inicial/Pro não troca o plano nem aparece na prévia", async () => {
  const cupom = { ...FUNDADOR5, codigo: "TRINTA", valor: 1000, dias_de_teste: 30 };
  const previa = await processarValidarCupom({ acao: "validar_cupom", codigo: "TRINTA", plano: "pro" }, dubles({ cupom }).deps);
  assert.equal(previa.http, 200);
  assert.equal("dias_de_teste" in previa.body.cupom, false);
  const { deps, c } = dubles({ cupom });
  const r = await processarCheckout({ ...PEDIDO, plano: "pro", cupom: "TRINTA" }, deps);
  assert.equal(r.http, 200, JSON.stringify(r.body));
  assert.equal(c.fetch[0].body.plan_id, "plan_p");
  assert.equal(c.registrar[0].trial_ends_at, new Date(AGORA.getTime() + 7 * DIA).toISOString());
});

test("sem as env do Escritório: o checkout dele responde PLANO_INDISPONIVEL; Inicial e Pro seguem", async () => {
  const semEscritorio = Object.fromEntries(Object.keys(ENV_ESCRITORIO).map((k) => [k, ""]));
  for (const faltando of [semEscritorio, { PAGARME_PLANO_FISCAL_ESCRITORIO_5_TESTE30_ID: "" }]) {
    const { deps, c } = dubles({ env: faltando });
    const r = await processarCheckout(PEDIDO, deps);
    assert.equal(r.http, 409);
    assert.equal(r.body.error_code, "PLANO_INDISPONIVEL");
    assert.match(r.body.mensagem, /Escritório ainda não está disponível/);
    assert.equal(c.fetch.length + c.reivindicar.length + c.registrar.length, 0);
  }
  const { deps, c } = dubles({ env: semEscritorio });
  const pro = await processarCheckout({ ...PEDIDO, plano: "pro" }, deps);
  assert.equal(pro.http, 200, JSON.stringify(pro.body));
  assert.equal(c.fetch[0].body.plan_id, "plan_p");
  assert.equal(configuracaoPublica({ ...ENV, ...semEscritorio }).escritorio_disponivel, false);
});

test("plano desconhecido continua 400", async () => {
  for (const plano of ["escritorio", "escritorio_10", "agencia"]) {
    const { deps, c } = dubles();
    const r = await processarCheckout({ ...PEDIDO, plano }, deps);
    assert.equal(r.http, 400, plano);
    assert.equal(c.fetch.length, 0);
  }
});

test("webhook: cobrança paga do Escritório vira Purchase do plano da faixa, sempre mensal", async () => {
  const c = { fetch: [] };
  const deps = {
    env: { META_ACCESS_TOKEN: "tok" },
    fetch: async (url, init) => {
      c.fetch.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ events_received: 1 }) };
    },
    reivindicar: async () => ({
      encontrada: true, enviar: true, ordem: 1, tenant_id: CONTEXTO.tenant_id, plano: "escritorio_5", ciclo: "anual",
      com_teste: true, email: CONTEXTO.email, telefone: CONTEXTO.phone_e164, fbp: null, fbc: null,
    }),
    agora: () => AGORA,
  };
  const r = await medirCobranca({ subscriptionId: "sub_e1", tipo: "invoice.paid", pagamento: { chave: "in_e1", centavos: null } }, deps);
  assert.equal(r.resultado, "enviado");
  assert.equal(r.ciclo, "mensal");
  assert.equal(r.valor_centavos, 29700, "sem valor no aviso: preço da faixa");
  const ev = c.fetch[0].body.data[0];
  assert.deepEqual(ev.custom_data.content_ids, ["nofiscal-escritorio_5-mensal"]);
  assert.equal(ev.custom_data.content_name, "nó.fiscal Escritório 5");
  assert.equal(ev.custom_data.value, 297);
});

test("script de planos cria os 9 do Escritório e imprime as variáveis", async () => {
  const criados = [];
  const fetch = async (_url, init) => {
    const corpo = JSON.parse(init.body);
    criados.push([corpo.metadata.codigo, corpo.trial_period_days ?? 0]);
    return { ok: true, status: 200, json: async () => ({ id: `plan_${corpo.metadata.codigo}` }) };
  };
  const codigos = ["escritorio_5", "escritorio_5_sem_teste", "escritorio_5_teste30", "escritorio_20", "escritorio_20_sem_teste",
    "escritorio_20_teste30", "escritorio_50", "escritorio_50_sem_teste", "escritorio_50_teste30"];
  const lista = await criarPlanosFiscal({ fetch, env: { PAGARME_SECRET_KEY: "sk_live" }, codigos });
  assert.deepEqual(criados.map((x) => x[1]), [7, 0, 30, 7, 0, 30, 7, 0, 30]);
  assert.deepEqual(lista.map((p) => `${p.env}=${p.id}`), Object.keys(ENV_ESCRITORIO).filter((k) => !/_ANUAL_/.test(k)).map((k) => {
    const codigo = codigos.find((c) => PLANOS_PAGARME[c].env === k);
    return `${k}=plan_${codigo}`;
  }));
});
