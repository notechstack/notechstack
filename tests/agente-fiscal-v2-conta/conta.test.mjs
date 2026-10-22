// Provas do lote B de .checks/agente-fiscal-v2.md: C16, C17, C18, C38s, C39, C40, C41, C42, C43 e C45.
// As ações passam pelo núcleo das edge functions `fiscal-conta` e `assinatura-fiscal-ciclo` e pelas
// funções `public.fiscal_*` no banco local, com o papel `service_role`. O Pagar.me é um dublê.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { processarConta } from "../../supabase/functions/fiscal-conta/core.ts";
import { processarCiclo } from "../../supabase/functions/assinatura-fiscal-ciclo/core.ts";
import { processarAviso } from "../../supabase/functions/assinatura-fiscal-webhook/core.ts";
import { abrirBancos, apagarEmpresa, criarAssinatura, criarEmpresa, funcoesDoBanco } from "./banco.mjs";

const API = "https://pagarme.simulado/core/v5";
const ENV = {
  PAGARME_ASSINATURA_SECRET_KEY: "sk_test_x",
  PAGARME_ASSINATURA_API_URL: `${API}/`,
  PAGARME_ASSINATURA_AMBIENTE: "sandbox",
};
const WEBHOOK_ENV = { PAGARME_FISCAL_WEBHOOK_USER: "pagarme", PAGARME_FISCAL_WEBHOOK_PASS: "senha-do-webhook" };
const BASIC = `Basic ${Buffer.from("pagarme:senha-do-webhook").toString("base64")}`;
const ENDERECO = { cep: "01001-000", rua: "Praça da Sé", numero: "100", bairro: "Sé", cidade: "São Paulo", uf: "SP" };
const DIA = 24 * 3600 * 1000;
const HORA = 3600 * 1000;

// Lista nacional do lote P, quando já está no repositório (critério 18: "6 dígitos da lista nacional").
const ARQ_CODIGOS = new URL("../../agentes/fiscal/dados/codigos-servico.json", import.meta.url);
const LISTA = existsSync(ARQ_CODIGOS)
  ? new Set(JSON.parse(readFileSync(ARQ_CODIGOS, "utf8")).itens.map((i) => i.codigo))
  : null;
const [CODIGO_A, CODIGO_B] = LISTA ? [...LISTA].slice(0, 2) : ["010701", "010702"];

const bancos = abrirBancos();
const banco = funcoesDoBanco(bancos.servico);
const empresas = [];

async function empresa(opcoes) {
  const e = await criarEmpresa(bancos.dono, opcoes);
  empresas.push(e);
  return e;
}

test.after(async () => {
  for (const e of empresas) await apagarEmpresa(bancos.dono, e);
  await bancos.fechar();
});

/** Dublê do Pagar.me: registra as chamadas; `respostas(method, url, body)` decide a resposta. */
function pagarme(respostas = () => ({})) {
  const chamadas = [];
  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    chamadas.push({ url, method: init.method, body });
    const r = respostas(init.method, url, body) || {};
    const http = r.http ?? 200;
    return { ok: http < 300, status: http, json: async () => r.json ?? {} };
  };
  return { fetch, chamadas };
}

async function conta(e, body, { gateway = pagarme(), sessao = e?.userId ?? null, env = {}, codigos = LISTA } = {}) {
  const r = await processarConta("POST", body, {
    env: { ...ENV, ...env },
    fetch: gateway.fetch,
    sessao: async () => sessao,
    estado: banco.estado,
    configurar: banco.configurar,
    trocarPlano: banco.trocarPlano,
    agendarCancelamento: banco.agendarCancelamento,
    apagarConta: banco.apagarConta,
    codigosServico: async () => codigos,
    log: () => {},
  });
  return { ...r, chamadas: gateway.chamadas };
}

async function tenantDe(e) {
  const { rows } = await bancos.dono.query(
    `select plan, monthly_note_limit, codigo_servico_nacional, p_tot_trib_sn::text as pct, contador_email,
            resumo_frequencia, resumo_dia, onboarding_etapa, active
       from nofiscal.fiscal_tenants where id = $1`,
    [e.tenantId],
  );
  return rows[0];
}

async function assinaturaDe(subUuid) {
  const { rows } = await bancos.dono.query(
    `select plano, status, cancelamento_agendado_para, cancelamento_pedido_em, cancelamento_origem
       from nofiscal.fiscal_subscriptions where id = $1`,
    [subUuid],
  );
  return rows[0];
}

async function bloqueio(e) {
  const { rows } = await bancos.dono.query("select nofiscal.emission_block($1) as b", [e.tenantId]);
  return rows[0].b;
}

async function aviso(tipo, subscriptionId) {
  return processarAviso(
    {
      metodo: "POST",
      authorization: BASIC,
      body: { id: `hook_${randomBytes(8).toString("hex")}`, type: tipo, data: { subscription: { id: subscriptionId } } },
    },
    { env: WEBHOOK_ENV, aplicarEvento: banco.aplicarEvento, log: () => {} },
  );
}

// ---------------------------------------------------------------------------------------------

test("configurar dados fiscais", async () => {
  const e = await empresa({ etapa: "dados_fiscais" });
  const r = await conta(e, { acao: "configurar", codigo_servico_nacional: CODIGO_A, p_tot_trib_sn: 6.5 });
  assert.equal(r.http, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.onboarding_etapa, "clientes");
  assert.equal(r.body.fiscal.codigo_servico_nacional, CODIGO_A);
  assert.equal(Number(r.body.fiscal.p_tot_trib_sn), 6.5);
  let t = await tenantDe(e);
  assert.equal(t.codigo_servico_nacional, CODIGO_A);
  assert.equal(t.pct, "6.50");
  assert.equal(t.onboarding_etapa, "clientes");

  // Reconfigurar depois: grava de novo e não volta nem pula etapa.
  const r2 = await conta(e, { acao: "configurar", codigo_servico_nacional: CODIGO_B, p_tot_trib_sn: "7,25" });
  assert.equal(r2.http, 200, JSON.stringify(r2.body));
  t = await tenantDe(e);
  assert.equal(t.codigo_servico_nacional, CODIGO_B);
  assert.equal(t.pct, "7.25");
  assert.equal(t.onboarding_etapa, "clientes");

  const concluido = await empresa({ etapa: "concluido", configurado: true });
  const r3 = await conta(concluido, { acao: "configurar", codigo_servico_nacional: CODIGO_B, p_tot_trib_sn: 0 });
  assert.equal(r3.http, 200, JSON.stringify(r3.body));
  t = await tenantDe(concluido);
  assert.equal(t.onboarding_etapa, "concluido");
  assert.equal(t.pct, "0.00");

  // configurar não fala com o Pagar.me.
  assert.equal(r.chamadas.length + r2.chamadas.length + r3.chamadas.length, 0);
});

test("MEI configura sem percentual do Simples e a emissão não fica bloqueada por ele", async () => {
  const e = await empresa({ etapa: "dados_fiscais", regime: "mei", certificado: true });
  const r = await conta(e, { acao: "configurar", codigo_servico_nacional: CODIGO_A });
  assert.equal(r.http, 200, JSON.stringify(r.body));
  assert.equal(r.body.empresa.regime, "mei");
  assert.equal(r.body.fiscal.p_tot_trib_sn, null);
  // Percentual enviado por engano é ignorado: MEI não informa pTotTribSN (E0710).
  const r2 = await conta(e, { acao: "configurar", codigo_servico_nacional: CODIGO_B, p_tot_trib_sn: 6 });
  assert.equal(r2.http, 200, JSON.stringify(r2.body));
  const t = await tenantDe(e);
  assert.equal(t.codigo_servico_nacional, CODIGO_B);
  assert.equal(t.pct, null);
  assert.equal(t.onboarding_etapa, "clientes");
  assert.notEqual(await bloqueio(e), "FISCAL_CONFIG_MISSING");

  // Direto no banco, o Simples continua exigindo o percentual.
  const simples = await empresa({ etapa: "dados_fiscais" });
  const direto = await banco.configurar(simples.userId, { codigo_servico_nacional: CODIGO_A });
  assert.equal(direto.campo, "p_tot_trib_sn");
});

test("contador e resumo por plano", async () => {
  const pro = await empresa({ plano: "pro" });
  const r = await conta(pro, {
    acao: "configurar",
    codigo_servico_nacional: CODIGO_A,
    p_tot_trib_sn: 6,
    contador_email: "contadora@example.test",
    resumo: { frequencia: "mensal", dia: 5 },
  });
  assert.equal(r.http, 200, JSON.stringify(r.body));
  assert.equal(r.body.fiscal.contador_email, "contadora@example.test");
  assert.deepEqual(r.body.fiscal.resumo, { frequencia: "mensal", dia: 5 });
  let t = await tenantDe(pro);
  assert.equal(t.contador_email, "contadora@example.test");
  assert.equal(t.resumo_frequencia, "mensal");
  assert.equal(t.resumo_dia, 5);

  // Semanal com dia da semana; contador ausente mantém.
  const r2 = await conta(pro, {
    acao: "configurar", codigo_servico_nacional: CODIGO_A, p_tot_trib_sn: 6, resumo: { frequencia: "semanal", dia: 1 },
  });
  assert.equal(r2.http, 200, JSON.stringify(r2.body));
  t = await tenantDe(pro);
  assert.equal(t.resumo_frequencia, "semanal");
  assert.equal(t.resumo_dia, 1);
  assert.equal(t.contador_email, "contadora@example.test");

  // null apaga.
  const r3 = await conta(pro, {
    acao: "configurar", codigo_servico_nacional: CODIGO_A, p_tot_trib_sn: 6, resumo: null, contador_email: null,
  });
  assert.equal(r3.http, 200, JSON.stringify(r3.body));
  t = await tenantDe(pro);
  assert.equal(t.resumo_frequencia, null);
  assert.equal(t.resumo_dia, null);
  assert.equal(t.contador_email, null);

  // Inicial com resumo: 403 PLANO_SEM_RESUMO e nada gravado.
  const inicial = await empresa({ plano: "inicial" });
  const antes = await tenantDe(inicial);
  const r4 = await conta(inicial, {
    acao: "configurar", codigo_servico_nacional: CODIGO_A, p_tot_trib_sn: 6, resumo: { frequencia: "mensal", dia: 5 },
  });
  assert.equal(r4.http, 403);
  assert.equal(r4.body.error_code, "PLANO_SEM_RESUMO");
  assert.deepEqual(await tenantDe(inicial), antes);

  // A função do banco repete a regra de plano.
  const direto = await banco.configurar(inicial.userId, {
    codigo_servico_nacional: CODIGO_A, p_tot_trib_sn: "6", resumo: { frequencia: "mensal", dia: 5 },
  });
  assert.equal(direto.erro, "PLANO_SEM_RESUMO");
  assert.deepEqual(await tenantDe(inicial), antes);
});

test("dados fiscais inválidos", async () => {
  const e = await empresa({ plano: "pro", etapa: "dados_fiscais" });
  const antes = await tenantDe(e);
  const casos = [
    [{ codigo_servico_nacional: CODIGO_A, p_tot_trib_sn: 100.01 }, "p_tot_trib_sn"],
    [{ codigo_servico_nacional: CODIGO_A, p_tot_trib_sn: "100.01" }, "p_tot_trib_sn"],
    [{ codigo_servico_nacional: CODIGO_A, p_tot_trib_sn: -1 }, "p_tot_trib_sn"],
    [{ codigo_servico_nacional: CODIGO_A, p_tot_trib_sn: 6.123 }, "p_tot_trib_sn"],
    [{ codigo_servico_nacional: "12345", p_tot_trib_sn: 6 }, "codigo_servico_nacional"],
    [{ codigo_servico_nacional: "1234567", p_tot_trib_sn: 6 }, "codigo_servico_nacional"],
    [{ p_tot_trib_sn: 6 }, "codigo_servico_nacional"],
    [{ codigo_servico_nacional: CODIGO_A, p_tot_trib_sn: 6, contador_email: "sem-arroba" }, "contador_email"],
    [{ codigo_servico_nacional: CODIGO_A, p_tot_trib_sn: 6, resumo: { frequencia: "mensal", dia: 29 } }, "resumo"],
    [{ codigo_servico_nacional: CODIGO_A, p_tot_trib_sn: 6, resumo: { frequencia: "semanal", dia: 8 } }, "resumo"],
  ];
  for (const [dados, campo] of casos) {
    const r = await conta(e, { acao: "configurar", ...dados });
    assert.equal(r.http, 422, `${JSON.stringify(dados)} → ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error_code, "DADOS_FISCAIS_INVALIDOS");
    assert.equal(r.body.campo, campo, JSON.stringify(dados));
    assert.deepEqual(await tenantDe(e), antes, `nada gravado: ${JSON.stringify(dados)}`);
  }

  // Código com 6 dígitos fora da lista nacional (com a lista carregada).
  const lista = LISTA ?? new Set([CODIGO_A, CODIGO_B]);
  const fora = ["999999", "000000", "123456"].find((c) => !lista.has(c));
  const r = await conta(e, { acao: "configurar", codigo_servico_nacional: fora, p_tot_trib_sn: 6 }, { codigos: lista });
  assert.equal(r.http, 422);
  assert.equal(r.body.campo, "codigo_servico_nacional");
  assert.deepEqual(await tenantDe(e), antes);

  // A função do banco também recusa (a edge function não é a única barreira).
  const direto = await banco.configurar(e.userId, { codigo_servico_nacional: CODIGO_A, p_tot_trib_sn: "100.01" });
  assert.equal(direto.erro, "DADOS_FISCAIS_INVALIDOS");
  assert.equal(direto.campo, "p_tot_trib_sn");
  assert.deepEqual(await tenantDe(e), antes);
});

test("estado da conta", async () => {
  const e = await empresa({ plano: "pro", etapa: "clientes", configurado: true, certificado: true });
  const { subId } = await criarAssinatura(bancos.dono, e, { status: "paga", criadaEm: new Date(Date.now() - 3 * DIA) });
  const r = await conta(e, { acao: "estado" });
  assert.equal(r.http, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.tenant_id, e.tenantId);
  assert.equal(r.body.plano, "pro");
  assert.equal(r.body.onboarding_etapa, "clientes");
  assert.equal(r.body.empresa.cnpj, e.cnpj);
  assert.equal(r.body.empresa.razao_social, `Empresa de teste ${e.cnpj}`);
  assert.equal(r.body.empresa.cnae, "6201501");
  assert.equal(r.body.empresa.responsavel, "Maria Responsável");
  assert.equal(r.body.empresa.email, e.email);
  assert.equal(r.body.empresa.telefone, e.telefone);
  assert.equal(r.body.assinatura.status, "paga");
  assert.equal(r.body.assinatura.com_teste, false);
  assert.ok(Object.hasOwn(r.body.assinatura, "trial_ends_at"));
  assert.equal(r.body.assinatura.cancelamento_agendado_para, null);
  assert.ok(Date.parse(r.body.assinatura.periodo_fim) > Date.now(), "periodo_fim no futuro");
  assert.equal(r.body.certificado.subject, `CN=EMPRESA TESTE:${e.cnpj}`);
  assert.ok(Date.parse(r.body.certificado.not_after) > Date.now());
  assert.equal(r.body.fiscal.codigo_servico_nacional, "010701");
  assert.equal(Number(r.body.fiscal.p_tot_trib_sn), 6);
  assert.ok(Object.hasOwn(r.body.fiscal, "contador_email"));
  assert.equal(r.body.fiscal.resumo, null);
  // Ids do Pagar.me não vão para a página.
  assert.equal(JSON.stringify(r.body).includes(subId), false);
  assert.equal(r.chamadas.length, 0);

  // No teste: trial_ends_at do tenant e periodo_fim = fim do teste.
  const fimTeste = new Date(Date.now() + 5 * DIA);
  const t = await empresa({ etapa: "certificado", trialEndsAt: fimTeste });
  await criarAssinatura(bancos.dono, t, { status: "pendente", comTeste: true });
  const rt = await conta(t, { acao: "estado" });
  assert.equal(rt.http, 200);
  assert.equal(rt.body.onboarding_etapa, "certificado");
  assert.equal(Date.parse(rt.body.assinatura.trial_ends_at), fimTeste.getTime());
  assert.equal(Date.parse(rt.body.assinatura.periodo_fim), fimTeste.getTime());
  assert.equal(rt.body.certificado, null);

  // Sem sessão: 401.
  const semSessao = await conta(e, { acao: "estado" }, { sessao: null });
  assert.equal(semSessao.http, 401);
  assert.equal(semSessao.body.error_code, "SEM_SESSAO");

  // Usuário sem empresa: 403 CONTA_SEM_EMPRESA.
  const userId = (await bancos.dono.query(
    `insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values (gen_random_uuid(), 'authenticated', 'authenticated', $1, '{}', '{}', now(), now()) returning id`,
    [`sem-empresa-${randomBytes(4).toString("hex")}@example.test`],
  )).rows[0].id;
  try {
    const r403 = await conta(null, { acao: "estado" }, { sessao: userId });
    assert.equal(r403.http, 403);
    assert.equal(r403.body.error_code, "CONTA_SEM_EMPRESA");
  } finally {
    await bancos.dono.query("delete from auth.users where id = $1", [userId]);
  }
});

test("trocar cartão", async () => {
  const e = await empresa({ configurado: true, certificado: true });
  const { subId } = await criarAssinatura(bancos.dono, e, { status: "recusada" });
  const r = await conta(e, { acao: "trocar_cartao", card_token: "token_novo123", endereco: ENDERECO });
  assert.equal(r.http, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true });
  assert.equal(r.chamadas.length, 1);
  const [c] = r.chamadas;
  assert.equal(c.method, "PATCH");
  assert.equal(c.url, `${API}/subscriptions/${subId}/payment-method`);
  assert.equal(c.body.payment_method, "credit_card");
  assert.equal(c.body.card_token, "token_novo123");
  assert.equal(c.body.card.billing_address.zip_code, "01001000");
  for (const campo of ["number", "cvv", "exp_month", "exp_year", "holder_name"]) {
    assert.equal(JSON.stringify(c.body).includes(`"${campo}"`), false, `sem ${campo}`);
  }

  // Cartão recusado pelo Pagar.me: 402.
  const recusa = await conta(e, { acao: "trocar_cartao", card_token: "token_ruim", endereco: ENDERECO }, {
    gateway: pagarme(() => ({ http: 422, json: { message: "card refused" } })),
  });
  assert.equal(recusa.http, 402);
  assert.equal(recusa.body.error_code, "CARTAO_RECUSADO");
  assert.equal(recusa.body.mensagem, "Cartão recusado. Tente outro cartão.");

  // Número do cartão no corpo: recusado antes do Pagar.me.
  const aberto = await conta(e, { acao: "trocar_cartao", card_token: "token_x", number: "4111111111111111" });
  assert.equal(aberto.http, 400);
  assert.equal(aberto.chamadas.length, 0);

  // Sem assinatura ativa: 409.
  const sem = await empresa({});
  const r409 = await conta(sem, { acao: "trocar_cartao", card_token: "token_novo123", endereco: ENDERECO });
  assert.equal(r409.http, 409);
  assert.equal(r409.body.error_code, "SEM_ASSINATURA");
  assert.equal(r409.chamadas.length, 0);
});

test("trocar plano", async () => {
  const e = await empresa({ plano: "inicial", configurado: true });
  const { id, subId } = await criarAssinatura(bancos.dono, e, { status: "paga" });
  const itens = (method, url) =>
    method === "GET" && url.endsWith("/items")
      ? { json: { data: [{ id: "si_velho", status: "deleted" }, { id: "si_ativo", status: "active" }] } }
      : { json: { id: "si_ativo" } };

  const r = await conta(e, { acao: "trocar_plano", plano: "pro" }, { gateway: pagarme(itens) });
  assert.equal(r.http, 200, JSON.stringify(r.body));
  assert.equal(r.body.plano, "pro");
  assert.equal(r.chamadas.length, 2);
  assert.equal(r.chamadas[0].method, "GET");
  assert.equal(r.chamadas[0].url, `${API}/subscriptions/${subId}/items`);
  assert.equal(r.chamadas[1].method, "PUT");
  assert.equal(r.chamadas[1].url, `${API}/subscriptions/${subId}/items/si_ativo`);
  assert.equal(r.chamadas[1].body.quantity, 1);
  assert.deepEqual(r.chamadas[1].body.pricing_scheme, { scheme_type: "unit", price: 12900 });
  let t = await tenantDe(e);
  assert.equal(t.plan, "pro");
  assert.equal(t.monthly_note_limit, 100);
  assert.equal((await assinaturaDe(id)).plano, "pro");

  const volta = await conta(e, { acao: "trocar_plano", plano: "inicial" }, { gateway: pagarme(itens) });
  assert.equal(volta.http, 200, JSON.stringify(volta.body));
  assert.equal(volta.chamadas[1].body.pricing_scheme.price, 4900);
  t = await tenantDe(e);
  assert.equal(t.plan, "inicial");
  assert.equal(t.monthly_note_limit, 20);
  assert.equal((await assinaturaDe(id)).plano, "inicial");

  // Pagar.me recusa a troca: nada muda no banco.
  const falha = await conta(e, { acao: "trocar_plano", plano: "pro" }, {
    gateway: pagarme((m) => (m === "PUT" ? { http: 500 } : itens(m, `${API}/x/items`))),
  });
  assert.equal(falha.http, 502);
  assert.equal((await tenantDe(e)).plan, "inicial");

  // Com cancelamento agendado: 409, sem chamar o Pagar.me.
  const ag = await empresa({ plano: "inicial" });
  await criarAssinatura(bancos.dono, ag, { status: "paga", agendadoPara: new Date(Date.now() + 10 * DIA) });
  const r409 = await conta(ag, { acao: "trocar_plano", plano: "pro" }, { gateway: pagarme(itens) });
  assert.equal(r409.http, 409);
  assert.equal(r409.body.error_code, "CANCELAMENTO_AGENDADO");
  assert.equal(r409.chamadas.length, 0);
});

/** Dia UTC ≤ 28, entre 3 e 27 dias atrás: a âncora do ciclo derivado tem um "+ 1 mês" sem ambiguidade. */
function criadaHaAlgunsDias() {
  for (let d = 10; d < 28; d += 1) {
    const c = new Date(Date.now() - d * DIA);
    if (c.getUTCDate() <= 28) return c;
  }
  throw new Error("sem data");
}

test("cancelamento agendado", async () => {
  const e = await empresa({ configurado: true, certificado: true, etapa: "concluido" });
  const { id, subId } = await criarAssinatura(bancos.dono, e, { status: "paga" });
  const fimCiclo = new Date(Date.now() + 20 * DIA);
  fimCiclo.setUTCHours(23, 59, 59, 0);
  const gw = pagarme((m) => (m === "GET" ? { json: { id: subId, current_cycle: { end_at: fimCiclo.toISOString() } } } : {}));

  const r = await conta(e, { acao: "cancelar" }, { gateway: gw });
  assert.equal(r.http, 200, JSON.stringify(r.body));
  assert.equal(r.body.cancelada_agora, false);
  // Fim do período pago = current_cycle.end_at − 1 hora (Landing, lote B).
  const esperado = fimCiclo.getTime() - HORA;
  assert.equal(Date.parse(r.body.cancelamento_agendado_para), esperado);
  // Só leu o ciclo: nada foi cancelado no Pagar.me.
  assert.deepEqual(r.chamadas.map((c) => `${c.method} ${c.url}`), [`GET ${API}/subscriptions/${subId}`]);

  const s = await assinaturaDe(id);
  assert.equal(s.cancelamento_agendado_para.getTime(), esperado);
  assert.equal(s.cancelamento_origem, "site");
  assert.ok(s.cancelamento_pedido_em instanceof Date);
  assert.equal(s.status, "paga");
  // A emissão segue liberada até a data.
  assert.equal(await bloqueio(e), null);

  // Pedir de novo devolve a mesma data.
  const r2 = await conta(e, { acao: "cancelar" }, { gateway: pagarme() });
  assert.equal(r2.http, 200);
  assert.equal(Date.parse(r2.body.cancelamento_agendado_para), esperado);
  assert.equal(r2.chamadas.length, 0);

  // O estado mostra o cancelamento agendado.
  const est = await conta(e, { acao: "estado" });
  assert.equal(Date.parse(est.body.assinatura.cancelamento_agendado_para), esperado);
  assert.equal(Date.parse(est.body.assinatura.periodo_fim), esperado);

  // Pagar.me fora do ar: o banco deriva o fim do ciclo pela âncora (created_at da assinatura sem teste).
  const d = await empresa({ configurado: true, certificado: true });
  const criada = criadaHaAlgunsDias();
  const { id: id2 } = await criarAssinatura(bancos.dono, d, { status: "paga", criadaEm: criada });
  const fora = await conta(d, { acao: "cancelar" }, { gateway: pagarme(() => ({ http: 503 })) });
  assert.equal(fora.http, 200, JSON.stringify(fora.body));
  const ancora = Date.UTC(criada.getUTCFullYear(), criada.getUTCMonth() + 1, criada.getUTCDate());
  const derivado = ancora - 1000 - HORA;
  assert.equal(Date.parse(fora.body.cancelamento_agendado_para), derivado);
  assert.equal((await assinaturaDe(id2)).cancelamento_agendado_para.getTime(), derivado);
  assert.equal(await bloqueio(d), null);
});

test("ciclo cancela as vencidas", async () => {
  const { rows } = await bancos.dono.query(
    "select decrypted_secret as s from vault.decrypted_secrets where name = 'FISCAL_CICLO_CRON_SECRET'");
  const segredo = rows[0].s;

  const vencida = await empresa({ configurado: true, certificado: true });
  const sv = await criarAssinatura(bancos.dono, vencida, { status: "paga", agendadoPara: new Date(Date.now() - 60 * 1000) });
  const futura = await empresa({ configurado: true, certificado: true });
  const sf = await criarAssinatura(bancos.dono, futura, { status: "paga", agendadoPara: new Date(Date.now() + DIA) });
  const jaCancelada = await empresa({});
  const sc = await criarAssinatura(bancos.dono, jaCancelada, {
    status: "cancelada", agendadoPara: new Date(Date.now() - DIA),
  });
  const semAgenda = await empresa({});
  const ss = await criarAssinatura(bancos.dono, semAgenda, { status: "paga" });

  const deps = (gw) => ({
    env: ENV,
    fetch: gw.fetch,
    segredoOk: banco.segredoOk,
    vencidas: banco.vencidas,
    log: () => {},
  });

  // Sem segredo ou com o errado: 401 e nenhuma chamada.
  for (const s of [null, "", "errado"]) {
    const gw = pagarme();
    const r = await processarCiclo({ metodo: "POST", segredo: s }, deps(gw));
    assert.equal(r.http, 401, `segredo ${s}`);
    assert.equal(gw.chamadas.length, 0);
  }

  const gw = pagarme();
  const r = await processarCiclo({ metodo: "POST", segredo }, deps(gw));
  assert.equal(r.http, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  const deletes = gw.chamadas.filter((c) => c.method === "DELETE").map((c) => c.url);
  assert.equal(gw.chamadas.length, deletes.length, "o ciclo só cancela");
  assert.ok(deletes.includes(`${API}/subscriptions/${sv.subId}`), "a vencida é cancelada");
  for (const outra of [sf.subId, sc.subId, ss.subId]) {
    assert.equal(deletes.includes(`${API}/subscriptions/${outra}`), false, `não cancela ${outra}`);
  }
  const corpo = gw.chamadas.find((c) => c.url.endsWith(sv.subId)).body;
  assert.deepEqual(corpo, { cancel_pending_invoices: true });

  // O status só muda com o aviso; depois dele a emissão para.
  assert.equal((await assinaturaDe(sv.id)).status, "paga");
  assert.equal(await bloqueio(vencida), null);
  const a = await aviso("subscription.canceled", sv.subId);
  assert.equal(a.http, 200);
  assert.equal((await assinaturaDe(sv.id)).status, "cancelada");
  assert.equal(await bloqueio(vencida), "SUBSCRIPTION_CANCELLED");

  // Falha do Pagar.me: conta como falha e a vencida volta na rodada seguinte (Unresolved 13).
  const outra = await empresa({});
  const so = await criarAssinatura(bancos.dono, outra, { status: "paga", agendadoPara: new Date(Date.now() - 1000) });
  const falha = await processarCiclo({ metodo: "POST", segredo }, deps(pagarme((m, url) => (url.endsWith(so.subId) ? { http: 500 } : {}))));
  assert.equal(falha.http, 200);
  assert.ok(falha.body.falhas >= 1);
  const fila = await banco.vencidas(50);
  assert.ok(fila.some((v) => v.pagarme_subscription_id === so.subId), "continua na fila");
});

test("cancelar no teste", async () => {
  const e = await empresa({ configurado: true, certificado: true, trialEndsAt: new Date(Date.now() + 5 * DIA) });
  const { id, subId } = await criarAssinatura(bancos.dono, e, { status: "pendente", comTeste: true });
  assert.equal(await bloqueio(e), null, "o teste emite");

  const antes = Date.now();
  const r = await conta(e, { acao: "cancelar" });
  assert.equal(r.http, 200, JSON.stringify(r.body));
  assert.equal(r.body.cancelada_agora, true);
  assert.equal(r.chamadas.length, 1);
  assert.equal(r.chamadas[0].method, "DELETE");
  assert.equal(r.chamadas[0].url, `${API}/subscriptions/${subId}`);
  assert.deepEqual(r.chamadas[0].body, { cancel_pending_invoices: true });
  const s = await assinaturaDe(id);
  assert.ok(s.cancelamento_agendado_para.getTime() <= Date.now() + 1000);
  assert.ok(s.cancelamento_agendado_para.getTime() >= antes - 60 * 1000);

  // O aviso do Pagar.me fecha: emissão para com SUBSCRIPTION_CANCELLED.
  await aviso("subscription.canceled", subId);
  assert.equal((await assinaturaDe(id)).status, "cancelada");
  assert.equal(await bloqueio(e), "SUBSCRIPTION_CANCELLED");

  // DELETE falhou: 502, e o cancelamento fica na fila do ciclo.
  const f = await empresa({ trialEndsAt: new Date(Date.now() + 5 * DIA) });
  const sf = await criarAssinatura(bancos.dono, f, { status: "pendente", comTeste: true });
  const falha = await conta(f, { acao: "cancelar" }, { gateway: pagarme(() => ({ http: 500 })) });
  assert.equal(falha.http, 502);
  assert.equal(falha.body.error_code, "PAGARME_FALHOU");
  const fila = await banco.vencidas(50);
  assert.ok(fila.some((v) => v.pagarme_subscription_id === sf.subId));
});

test("apagar conta", async () => {
  const e = await empresa({ plano: "pro", configurado: true, certificado: true, etapa: "concluido" });
  const { subId } = await criarAssinatura(bancos.dono, e, { status: "paga" });
  await bancos.dono.query("update nofiscal.fiscal_tenants set contador_email = 'contadora@example.test' where id = $1", [e.tenantId]);
  await bancos.dono.query(
    `insert into nofiscal.fiscal_models (tenant_id, nome, tomador_documento, tomador_nome, codigo_servico_nacional, descricao, origem)
     values ($1, 'Prontia', '11444777000161', 'Prontia Saúde', '010701', 'Consultoria', 'importacao_pdf')`,
    [e.tenantId],
  );
  const req = await bancos.dono.query(
    "insert into nofiscal.fiscal_requests (tenant_id, phone_id, kind) values ($1, $2, 'emitir') returning id",
    [e.tenantId, e.phoneId],
  );
  await bancos.dono.query(
    `insert into nofiscal.fiscal_verification_codes (purpose, user_id, code_hash, expires_at)
     values ('whatsapp_activation', $1, $2, now() + interval '1 day')`,
    [e.userId, "a".repeat(64)],
  );
  await bancos.dono.query(
    `insert into nofiscal.fiscal_verification_codes (purpose, phone_id, code_hash, expires_at)
     values ('phone_authorization', $1, $2, now() + interval '1 day')`,
    [e.phoneId, "b".repeat(64)],
  );
  const nota = await bancos.dono.query(
    "insert into nofiscal.fiscal_invoices (tenant_id, external_id, payload, status) values ($1, $2, '{}'::jsonb, 'issued') returning id",
    [e.tenantId, req.rows[0].id],
  );
  const secret = (await bancos.dono.query(
    "select vault_secret_id from nofiscal.fiscal_certificates where tenant_id = $1", [e.tenantId])).rows[0].vault_secret_id;
  const conte = async (sql, args) => Number((await bancos.dono.query(sql, args)).rows[0].n);

  // Sem APAGAR: 422 e nada feito.
  for (const confirmacao of [undefined, "apagar", "SIM"]) {
    const r = await conta(e, { acao: "apagar_conta", confirmacao });
    assert.equal(r.http, 422, String(confirmacao));
    assert.equal(r.body.error_code, "CONFIRMACAO_INVALIDA");
    assert.equal(r.chamadas.length, 0);
  }
  assert.equal(await conte("select count(*) n from nofiscal.fiscal_models where tenant_id = $1", [e.tenantId]), 1);

  // Pagar.me fora: 502 e nada apagado.
  const fora = await conta(e, { acao: "apagar_conta", confirmacao: "APAGAR" }, { gateway: pagarme(() => ({ http: 500 })) });
  assert.equal(fora.http, 502);
  assert.equal(await conte("select count(*) n from vault.secrets where id = $1", [secret]), 1);
  assert.equal(await conte("select count(*) n from nofiscal.fiscal_accounts where user_id = $1", [e.userId]), 1);

  const r = await conta(e, { acao: "apagar_conta", confirmacao: "APAGAR" });
  assert.equal(r.http, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true });
  // Cancelada na hora no Pagar.me.
  assert.deepEqual(r.chamadas.map((c) => `${c.method} ${c.url}`), [`DELETE ${API}/subscriptions/${subId}`]);
  assert.deepEqual(r.chamadas[0].body, { cancel_pending_invoices: true });

  // Segredo do A1 fora do Vault; certificado, modelos, números e códigos apagados.
  assert.equal(await conte("select count(*) n from vault.secrets where id = $1", [secret]), 0);
  assert.equal(await conte("select count(*) n from nofiscal.fiscal_certificates where tenant_id = $1", [e.tenantId]), 0);
  assert.equal(await conte("select count(*) n from nofiscal.fiscal_models where tenant_id = $1", [e.tenantId]), 0);
  assert.equal(await conte("select count(*) n from nofiscal.fiscal_phones where tenant_id = $1", [e.tenantId]), 0);
  assert.equal(await conte(
    "select count(*) n from nofiscal.fiscal_verification_codes where user_id = $1 or phone_id = $2", [e.userId, e.phoneId]), 0);
  assert.equal(await conte("select count(*) n from nofiscal.fiscal_accounts where user_id = $1", [e.userId]), 0);
  assert.equal(await conte("select count(*) n from public.memberships where user_id = $1 and client_id = $2", [e.userId, e.clientId]), 0);

  // O login não abre mais a conta: estado e checkout não acham empresa.
  const depois = await conta(e, { acao: "estado" });
  assert.equal(depois.http, 403);
  assert.equal(depois.body.error_code, "CONTA_SEM_EMPRESA");
  assert.equal(await banco.contextoCheckout(e.userId), null);

  // Ficam as notas e o tenant inativo, sem o e-mail do contador.
  assert.equal(await conte("select count(*) n from nofiscal.fiscal_invoices where id = $1", [nota.rows[0].id]), 1);
  const t = await tenantDe(e);
  assert.equal(t.active, false);
  assert.equal(t.contador_email, null);
  assert.equal(await bloqueio(e), "TENANT_INACTIVE");
});
