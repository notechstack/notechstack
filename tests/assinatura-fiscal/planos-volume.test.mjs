// Planos por volume e módulos (Lucca, 23/11/2026): faixas de 1.000 e 10.000 documentos com o plano achado ou criado no
// Pagar.me, o segundo tipo de nota cobrado no próprio plano, o que a conta emite gravado depois do registro e o módulo
// Guias ligado no checkout. Sem banco: dependências em dublê.
import test from "node:test";
import assert from "node:assert/strict";
import {
  CUPOM_MODULOS_JUNTOS,
  FAIXAS_ESCRITORIO,
  TEXTO_ACEITE_FISCAL,
  centavosDoCiclo,
  configuracaoPublica,
  corpoDoPlano,
  lerNotas,
  lerPlano,
  planoDeEscritorio,
  processarCheckout,
  processarValidarCupom,
} from "../../supabase/functions/assinatura-fiscal/core.ts";

const AGORA = new Date("2026-11-23T15:00:00Z");
const ENV = {
  PAGARME_ASSINATURA_SECRET_KEY: "sk_test_x",
  PAGARME_ASSINATURA_API_URL: "https://pagarme.simulado/core/v5",
  PAGARME_PLANO_FISCAL_INICIAL_ID: "plan_i",
  PAGARME_PLANO_FISCAL_PRO_ID: "plan_p",
  PAGARME_PLANO_FISCAL_INICIAL_SEM_TESTE_ID: "plan_is",
  PAGARME_PLANO_FISCAL_PRO_SEM_TESTE_ID: "plan_ps",
  PAGARME_PLANO_FISCAL_ESCRITORIO_5_ID: "plan_e5",
  PAGARME_PLANO_FISCAL_ESCRITORIO_5_SEM_TESTE_ID: "plan_e5s",
  PAGARME_PLANO_FISCAL_ESCRITORIO_5_TESTE30_ID: "plan_e5t30",
  PAGARME_PLANO_FISCAL_ESCRITORIO_5_ANUAL_ID: "plan_e5a",
  PAGARME_PLANO_FISCAL_ESCRITORIO_5_ANUAL_SEM_TESTE_ID: "plan_e5as",
  FISCAL_VENDA_ABERTA: "sim",
  FISCAL_TRIAL_SALT: "sal",
};
const CONTEXTO = {
  tenant_id: "00000000-0000-4000-8000-000000000007",
  cnpj: "11444777000161",
  razao_social: "Escritório Contábil Teste",
  email: "sandra@example.test",
  phone_e164: "+5511987654321",
  trial_ends_at: null,
  assinatura: null,
};
const PEDIDO = {
  plano: "escritorio_1000",
  card_token: "token_x",
  endereco: { cep: "01001000", rua: "Praça da Sé", numero: "1", bairro: "Sé", cidade: "São Paulo", uf: "SP" },
  termos_aceite: true,
  aceite_texto: TEXTO_ACEITE_FISCAL,
};

/** Pagar.me de mentira: guarda os planos criados e os devolve na busca por nome. */
function dubles({ env = {}, testeLiberado = true, cupom = null, planosNoPagarme = [], planoFalha = false, guias = { ok: true } } = {}) {
  const planos = [...planosNoPagarme];
  const c = { fetch: [], reivindicar: 0, registrar: [], tipos: [], guias: [] };
  const deps = {
    env: { ...ENV, ...env },
    agora: () => AGORA,
    sessao: async () => "user-1",
    contexto: async () => CONTEXTO,
    reivindicarTeste: async () => { c.reivindicar += 1; return testeLiberado; },
    registrar: async (l) => { c.registrar.push(l); return { id: "assin-v1", status: l.status }; },
    validarCupom: async () => cupom,
    usarCupom: async () => ({ ok: true }),
    definirTiposNota: async (t, notas) => { c.tipos.push([t, notas]); },
    ligarGuias: async (...a) => { c.guias.push(a); if (guias === "excecao") throw new Error("rede"); return guias; },
    fetch: async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      c.fetch.push({ url, method: init.method, body, headers: init.headers });
      const caminho = new URL(url).pathname.replace("/core/v5", "");
      if (caminho === "/plans" && init.method === "GET") {
        const nome = new URL(url).searchParams.get("name");
        // A busca do Pagar.me é por trecho do nome: devolve também os parecidos.
        return { ok: true, status: 200, json: async () => ({ data: planos.filter((p) => p.name.includes(nome)) }) };
      }
      if (caminho === "/plans" && init.method === "POST") {
        if (planoFalha) return { ok: false, status: 500, json: async () => ({}) };
        const plano = { id: `plan_auto_${planos.length + 1}`, status: "active", ...body };
        planos.push(plano);
        return { ok: true, status: 200, json: async () => plano };
      }
      return { ok: true, status: 200, json: async () => ({ id: "sub_v1", status: "future", customer: { id: "cus_1" } }) };
    },
    log: () => {},
  };
  return { deps, c, planos };
}
const chamadas = (c, metodo, fim) => c.fetch.filter((f) => f.method === metodo && new URL(f.url).pathname.endsWith(fim));

test("faixas por volume: cinco códigos, documentos por mês, empresas sem limite", () => {
  assert.deepEqual(Object.keys(FAIXAS_ESCRITORIO), ["escritorio_5", "escritorio_1000", "escritorio_20", "escritorio_50", "escritorio_10000"]);
  assert.deepEqual(Object.values(FAIXAS_ESCRITORIO).map((f) => [f.notas, f.centavos]), [[500, 29700], [1000, 49700], [2000, 79700], [5000, 149700], [10000, 249700]]);
  for (const f of Object.values(FAIXAS_ESCRITORIO)) assert.equal(f.empresas, 100000);
  for (const p of ["escritorio_1000", "escritorio_10000"]) {
    assert.equal(planoDeEscritorio(p), true);
    assert.equal(lerPlano(p), p);
  }
  // Os apelidos do site (escritorio_500...) não são código de servidor.
  assert.equal(lerPlano("escritorio_500"), null);
  assert.equal(planoDeEscritorio("toString"), false);
  // Anual das faixas novas: 25% e 45% OFF.
  assert.equal(centavosDoCiclo("escritorio_1000", "anual"), 447300);
  assert.equal(centavosDoCiclo("escritorio_10000", "anual"), 1648020);
  const c = configuracaoPublica(ENV);
  assert.deepEqual(c.planos.escritorio_1000, { valor_centavos: 49700, anual_centavos: 447300, empresas: 100000, notas: 1000 });
  assert.deepEqual(c.modulos, { segunda_nota_centavos: 19700, guias_centavos: 19700, juntos_centavos: 29700 });
});

test("lerNotas: ausente é só NFS-e; NF-e só no Escritório; ordem fixa; lixo é inválido", () => {
  assert.deepEqual(lerNotas(undefined, "pro"), ["nfse"]);
  assert.deepEqual(lerNotas(["nfse"], "inicial"), ["nfse"]);
  assert.equal(lerNotas(["nfe"], "pro"), null);
  assert.equal(lerNotas(["nfse", "nfe"], "inicial"), null);
  assert.deepEqual(lerNotas(["nfe"], "escritorio_5"), ["nfe"]);
  assert.deepEqual(lerNotas(["nfe", "nfse"], "escritorio_1000"), ["nfse", "nfe"]);
  for (const ruim of [[], ["nfse", "nfse"], ["cte"], "nfse", ["nfse", "nfe", "nfse"], [1]]) assert.equal(lerNotas(ruim, "escritorio_5"), null, JSON.stringify(ruim));
});

test("planos com as duas notas: R$ 197 a mais no mês, desconto da faixa no ano, nome próprio", () => {
  assert.equal(centavosDoCiclo("escritorio_5", "mensal", true), 49400);
  assert.equal(centavosDoCiclo("escritorio_20", "anual", true), Math.round((79700 + 19700) * 12 * 0.7));
  assert.equal(centavosDoCiclo("pro", "mensal", true), 12900, "Inicial e Pro não têm segundo tipo de nota");
  const base = corpoDoPlano("escritorio_5");
  assert.equal(base.name, "Agente Fiscal Escritório 5", "o plano que já existe não muda de nome");
  const duas = corpoDoPlano("escritorio_5_teste30", true);
  assert.equal(duas.name, "Agente Fiscal Escritório 5 com NFS-e e NF-e (teste de 30 dias)");
  assert.equal(duas.items[0].pricing_scheme.price, 49400);
  assert.equal(duas.trial_period_days, 30);
  assert.equal(duas.metadata.codigo, "escritorio_5_teste30_duas_notas");
  const anual = corpoDoPlano("escritorio_10000_anual_sem_teste", true);
  assert.equal(anual.name, "Agente Fiscal Escritório 10.000 documentos com NFS-e e NF-e anual (sem teste)");
  assert.equal(anual.interval, "year");
  assert.equal(anual.items[0].pricing_scheme.price, Math.round((249700 + 19700) * 12 * 0.55));
});

test("faixa de 1.000 sem id nos secrets: o checkout cria os planos no Pagar.me e assina no de 7 dias", async () => {
  const { deps, c } = dubles();
  const r = await processarCheckout(PEDIDO, deps);
  assert.equal(r.http, 200, JSON.stringify(r.body));
  const criados = chamadas(c, "POST", "/plans");
  assert.deepEqual(criados.map((p) => p.body.name), ["Agente Fiscal Escritório 1.000 documentos", "Agente Fiscal Escritório 1.000 documentos (sem teste)"]);
  assert.equal(criados[0].body.items[0].pricing_scheme.price, 49700);
  assert.equal(criados[0].body.trial_period_days, 7);
  assert.equal(criados[0].headers["Idempotency-Key"], "nofiscal-plano-escritorio_1000-49700-v1");
  const sub = chamadas(c, "POST", "/subscriptions")[0].body;
  assert.equal(sub.plan_id, "plan_auto_1");
  assert.equal(sub.metadata.plano, "escritorio_1000");
  assert.equal("notas" in sub.metadata, false, "só NFS-e: metadata igual à de antes");
  assert.equal(c.registrar[0].plano, "escritorio_1000");
  assert.deepEqual(c.tipos, [[CONTEXTO.tenant_id, ["nfse"]]]);
  assert.deepEqual(r.body.notas, ["nfse"]);
  assert.equal(r.body.guias, false);
  assert.equal(r.body.modulos_pendentes, undefined);
  assert.equal(r.body.medicao.valor, 497);
});

test("plano já existe no Pagar.me: é achado pelo nome e pelo preço, sem criar outro", async () => {
  const planosNoPagarme = [
    // Mesmo trecho no nome, mas outro plano: não serve.
    { id: "plan_outro", status: "active", name: "Agente Fiscal Escritório 1.000 documentos (sem teste)", interval: "month", items: [{ pricing_scheme: { price: 49700 } }] },
    { id: "plan_caro", status: "active", name: "Agente Fiscal Escritório 1.000 documentos", interval: "month", items: [{ pricing_scheme: { price: 99900 } }] },
    { id: "plan_certo", status: "active", name: "Agente Fiscal Escritório 1.000 documentos", interval: "month", items: [{ pricing_scheme: { price: 49700 } }] },
  ];
  const { deps, c } = dubles({ planosNoPagarme });
  const r = await processarCheckout(PEDIDO, deps);
  assert.equal(r.http, 200, JSON.stringify(r.body));
  assert.equal(chamadas(c, "POST", "/plans").length, 0);
  assert.equal(chamadas(c, "POST", "/subscriptions")[0].body.plan_id, "plan_certo");
});

test("Pagar.me não cria o plano: PLANO_INDISPONIVEL antes de reivindicar o teste e de cobrar", async () => {
  const { deps, c } = dubles({ planoFalha: true });
  const r = await processarCheckout(PEDIDO, deps);
  assert.equal(r.http, 409);
  assert.equal(r.body.error_code, "PLANO_INDISPONIVEL");
  assert.equal(c.reivindicar, 0);
  assert.equal(chamadas(c, "POST", "/subscriptions").length, 0);
  assert.equal(c.registrar.length, 0);
});

test("FUNDADOR1000: plano de 30 dias criado, R$ 100 de desconto por 12 ciclos", async () => {
  const cupom = { ok: true, codigo: "FUNDADOR1000", descricao: null, tipo: "valor", valor: 10000, cortesia: false, ciclos: 12, dias_de_teste: 30 };
  const { deps, c } = dubles({ cupom, testeLiberado: false });
  const r = await processarCheckout({ ...PEDIDO, cupom: "FUNDADOR1000" }, deps);
  assert.equal(r.http, 200, JSON.stringify(r.body));
  const trinta = chamadas(c, "POST", "/plans").find((p) => p.body.trial_period_days === 30);
  assert.equal(trinta.body.name, "Agente Fiscal Escritório 1.000 documentos (teste de 30 dias)");
  const sub = chamadas(c, "POST", "/subscriptions")[0].body;
  assert.deepEqual(sub.discounts, [{ value: 10000, discount_type: "flat", cycles: 12 }]);
  assert.equal(r.body.dias_de_teste, 30);
  assert.equal(r.body.medicao.valor, 397);
});

test("faixa antiga com um só tipo de nota segue no id dos secrets; só NF-e grava a NF-e como o que a conta emite", async () => {
  const { deps, c } = dubles();
  const r = await processarCheckout({ ...PEDIDO, plano: "escritorio_5", notas: ["nfe"] }, deps);
  assert.equal(r.http, 200, JSON.stringify(r.body));
  assert.equal(chamadas(c, "GET", "/plans").length, 0, "nenhuma consulta de plano");
  const sub = chamadas(c, "POST", "/subscriptions")[0].body;
  assert.equal(sub.plan_id, "plan_e5");
  assert.equal(sub.metadata.notas, "nfe");
  assert.deepEqual(c.tipos, [[CONTEXTO.tenant_id, ["nfe"]]]);
  assert.equal(r.body.medicao.valor, 297, "um tipo de nota: o preço do plano");
});

test("NFS-e + NF-e na faixa antiga: plano próprio, R$ 494, as duas notas gravadas", async () => {
  const { deps, c } = dubles({ testeLiberado: false });
  const r = await processarCheckout({ ...PEDIDO, plano: "escritorio_5", notas: ["nfe", "nfse"] }, deps);
  assert.equal(r.http, 200, JSON.stringify(r.body));
  const criados = chamadas(c, "POST", "/plans");
  assert.deepEqual(criados.map((p) => p.body.name), [
    "Agente Fiscal Escritório 5 com NFS-e e NF-e",
    "Agente Fiscal Escritório 5 com NFS-e e NF-e (sem teste)",
  ]);
  assert.equal(criados[1].headers["Idempotency-Key"], "nofiscal-plano-escritorio_5_sem_teste_duas_notas-49400-v1");
  const sub = chamadas(c, "POST", "/subscriptions")[0].body;
  assert.equal(sub.plan_id, "plan_auto_2", "teste já usado: o plano sem teste");
  assert.equal(sub.metadata.notas, "nfse,nfe");
  assert.deepEqual(c.tipos, [[CONTEXTO.tenant_id, ["nfse", "nfe"]]]);
  assert.equal(r.body.medicao.evento, "Purchase");
  assert.equal(r.body.medicao.valor, 494);
});

test("anual com as duas notas sem teste: a confirmação mostra o valor do ano com o segundo tipo de nota", async () => {
  const { deps, c } = dubles({ testeLiberado: false });
  const r = await processarCheckout({ ...PEDIDO, plano: "escritorio_5", ciclo: "anual", notas: ["nfse", "nfe"] }, deps);
  assert.equal(r.http, 409);
  assert.equal(r.body.error_code, "CONFIRMAR_SEM_TESTE");
  assert.equal(r.body.valor_centavos, Math.round(49400 * 12 * 0.75));
  assert.equal(chamadas(c, "POST", "/subscriptions").length, 0);
});

test("Guias no checkout: ligado depois do registro, com a franquia da faixa; com a NF-e, leva o desconto dos dois", async () => {
  let d = dubles();
  let r = await processarCheckout({ ...PEDIDO, guias: true }, d.deps);
  assert.equal(r.http, 200, JSON.stringify(r.body));
  // Com teste de 7 dias, o Guias começa no fim do teste, junto com a primeira cobrança da principal.
  assert.deepEqual(d.c.guias, [[CONTEXTO.tenant_id, 1000, null, new Date(AGORA.getTime() + 7 * 24 * 3600 * 1000).toISOString()]]);
  assert.equal(r.body.guias, true);
  assert.equal(chamadas(d.c, "POST", "/subscriptions")[0].body.metadata.guias, true);

  d = dubles();
  r = await processarCheckout({ ...PEDIDO, plano: "escritorio_5", notas: ["nfse", "nfe"], guias: true }, d.deps);
  assert.equal(r.http, 200, JSON.stringify(r.body));
  assert.deepEqual(d.c.guias.map((g) => g.slice(0, 3)), [[CONTEXTO.tenant_id, 500, CUPOM_MODULOS_JUNTOS]]);
  assert.equal(d.c.registrar.length, 1, "o Guias só é ligado com a principal registrada");
});

test("Guias não liga: a assinatura vale, e a resposta diz o que ficou pendente", async () => {
  for (const guias of [{ ok: false, erro: "PAGARME_FALHOU" }, "excecao"]) {
    const { deps, c } = dubles({ guias });
    const r = await processarCheckout({ ...PEDIDO, guias: true }, deps);
    assert.equal(r.http, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.guias, false);
    assert.deepEqual(r.body.modulos_pendentes, ["guias"]);
    assert.equal(c.registrar.length, 1);
  }
});

test("Inicial e Pro: NF-e no pedido é 400; Guias é ignorado; nada de módulo é chamado", async () => {
  let d = dubles();
  let r = await processarCheckout({ ...PEDIDO, plano: "pro", notas: ["nfse", "nfe"] }, d.deps);
  assert.equal(r.http, 400);
  assert.equal(d.c.fetch.length, 0);
  d = dubles();
  r = await processarCheckout({ ...PEDIDO, plano: "pro", guias: true }, d.deps);
  assert.equal(r.http, 200, JSON.stringify(r.body));
  assert.equal(chamadas(d.c, "POST", "/subscriptions")[0].body.plan_id, "plan_p");
  assert.deepEqual(d.c.guias, []);
  assert.deepEqual(d.c.tipos, []);
  assert.equal("notas" in r.body, false);
});

test("sem teste grátis, o Guias começa (e cobra) já: nada de módulo de graça até a renovação, nem no anual", async () => {
  for (const extra of [{}, { ciclo: "anual", confirmar_sem_teste: true }]) {
    const { deps, c } = dubles({ testeLiberado: false });
    const r = await processarCheckout({ ...PEDIDO, guias: true, ...extra }, deps);
    assert.equal(r.http, 200, JSON.stringify(r.body));
    assert.equal(r.body.com_teste, false);
    assert.deepEqual(c.guias, [[CONTEXTO.tenant_id, 1000, null, null]], JSON.stringify(extra));
  }
});

test("cupom dos dois módulos já usado pela conta: o Guias liga sem o desconto, em vez de ficar desligado", async () => {
  const { deps, c } = dubles();
  deps.ligarGuias = async (...a) => { c.guias.push(a); return a[2] ? { ok: false, erro: "CUPOM_JA_USADO" } : { ok: true }; };
  const r = await processarCheckout({ ...PEDIDO, plano: "escritorio_5", notas: ["nfse", "nfe"], guias: true }, deps);
  assert.equal(r.http, 200, JSON.stringify(r.body));
  assert.deepEqual(c.guias.map((g) => g[2]), [CUPOM_MODULOS_JUNTOS, null]);
  assert.equal(r.body.guias, true);
  assert.equal(r.body.modulos_pendentes, undefined);
});

test("prévia do cupom com as duas notas: o desconto é sobre o que o Pagar.me cobra (plano + segundo tipo de nota)", async () => {
  const dez = { ok: true, codigo: "DEZ", descricao: null, tipo: "percentual", valor: 10, cortesia: false, ciclos: 3 };
  const { deps } = dubles({ cupom: dez });
  const uma = await processarValidarCupom({ acao: "validar_cupom", codigo: "DEZ", plano: "escritorio_5", ciclo: "mensal" }, deps);
  assert.equal(uma.body.cupom.valor_centavos, 29700);
  assert.equal(uma.body.cupom.valor_centavos_com_desconto, 26730);
  const duas = await processarValidarCupom({ acao: "validar_cupom", codigo: "DEZ", plano: "escritorio_5", ciclo: "mensal", notas: ["nfse", "nfe"] }, deps);
  assert.equal(duas.body.cupom.valor_centavos, 49400);
  assert.equal(duas.body.cupom.valor_centavos_com_desconto, 44460);
});

test("Guias: sem inicio_em vale a próxima cobrança da principal; com ele, o fim do teste ou já", async () => {
  const { corpoAssinaturaGuias } = await import("../../supabase/functions/assinatura-fiscal-guias/core.ts");
  const base = {
    planId: "plan_g", tenantId: CONTEXTO.tenant_id, limite: 500, cupom: null, agora: AGORA,
    principal: { status: "active", customerId: "cus_1", cardId: "card_1", proximaCobranca: "2027-11-23T15:00:00.000Z" },
  };
  assert.equal(corpoAssinaturaGuias(base).start_at, "2027-11-23T15:00:00.000Z", "a nó ligando: próxima cobrança da principal");
  assert.equal("start_at" in corpoAssinaturaGuias({ ...base, inicioEm: null }), false, "checkout sem teste: começa já");
  assert.equal(corpoAssinaturaGuias({ ...base, inicioEm: "2026-11-30T15:00:00.000Z" }).start_at, "2026-11-30T15:00:00.000Z", "checkout com teste: fim do teste");
  assert.equal("start_at" in corpoAssinaturaGuias({ ...base, inicioEm: "2026-11-01T00:00:00.000Z" }), false, "data passada: começa já");
});
