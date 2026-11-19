// Assinatura "nó.fiscal Guias" (migração 20261119190000 e supabase/functions/assinatura-fiscal-guias): segunda
// assinatura no Pagar.me, no cartão da principal, começando na próxima cobrança dela; cupom FUNDADORGUIAS; ligar só pela
// nó; idempotência; recusas; cancelamento em cascata (desligar, webhook e ciclo); webhooks da Guias. Banco local com o
// papel service_role (como as edge functions) e o Pagar.me num dublê em memória: nada sai da máquina.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  PLANO_GUIAS, autorizadoServico, corpoDoPlanoGuias, processarGuias,
} from "../../supabase/functions/assinatura-fiscal-guias/core.ts";
import { processarAviso } from "../../supabase/functions/assinatura-fiscal-webhook/core.ts";
import { processarCiclo } from "../../supabase/functions/assinatura-fiscal-ciclo/core.ts";
import { criarPlanoGuias } from "../../scripts/pagarme-assinatura/criar-plano-guias.mjs";
import { abrirBancos, apagarEmpresa, criarEmpresa, funcoesDoBanco } from "./banco.mjs";

const bancos = abrirBancos();
const banco = funcoesDoBanco(bancos.servico);
const empresas = [];
const API = "https://pagarme.simulado/core/v5";
const ENV = {
  PAGARME_ASSINATURA_SECRET_KEY: "sk_test_guias",
  PAGARME_ASSINATURA_API_URL: API,
  PAGARME_ASSINATURA_AMBIENTE: "sandbox",
  PAGARME_PLANO_FISCAL_GUIAS_ID: "plan_guias_teste",
};
const FIM_DO_TESTE = "2026-12-16T18:42:00.000Z";
const AGORA = new Date("2026-11-19T15:00:00Z");

const rpc = async (nome, args) => {
  const nomes = Object.keys(args);
  const { rows } = await bancos.servico.query(
    `select public.${nome}(${nomes.map((n, i) => `${n} => $${i + 1}`).join(", ")}) as r`,
    nomes.map((n) => args[n]),
  );
  return rows[0].r;
};

/** Pagar.me em memória: GET/POST/DELETE de /subscriptions, com Idempotency-Key no POST. */
function pagarme() {
  const subs = new Map();
  const chamadas = [];
  const idempotentes = new Map();
  const falhar = { delete: false };
  const resp = (status, corpo) => new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });
  return {
    subs, chamadas, falhar,
    fetch: async (url, init = {}) => {
      const u = new URL(url);
      const metodo = init.method || "GET";
      const corpo = init.body ? JSON.parse(init.body) : null;
      chamadas.push({ metodo, caminho: u.pathname.replace("/core/v5", ""), corpo, headers: init.headers || {} });
      const m = /\/subscriptions\/([^/]+)$/.exec(u.pathname);
      if (metodo === "GET" && m) return subs.has(m[1]) ? resp(200, subs.get(m[1])) : resp(404, { message: "not found" });
      if (metodo === "DELETE" && m) {
        if (falhar.delete) return resp(500, { message: "fora" });
        if (!subs.has(m[1])) return resp(404, {});
        subs.get(m[1]).status = "canceled";
        return resp(200, subs.get(m[1]));
      }
      if (metodo === "POST" && u.pathname.endsWith("/subscriptions")) {
        const chave = (init.headers || {})["Idempotency-Key"];
        if (chave && idempotentes.has(chave)) return resp(200, subs.get(idempotentes.get(chave)));
        const id = `sub_guias_${randomBytes(6).toString("hex")}`;
        subs.set(id, { id, status: corpo.start_at ? "future" : "active", ...corpo });
        if (chave) idempotentes.set(chave, id);
        return resp(200, subs.get(id));
      }
      return resp(404, {});
    },
  };
}

function depsGuias(pg) {
  return {
    env: ENV,
    fetch: pg.fetch,
    agora: () => AGORA,
    contexto: (t) => rpc("fiscal_guias_contexto", { p_tenant_id: t }),
    reservar: (t, l) => rpc("fiscal_guias_reservar", { p_tenant_id: t, p_limite_mes: l }),
    soltar: async (t) => { await rpc("fiscal_guias_soltar", { p_tenant_id: t }); },
    registrar: (a) => rpc("fiscal_guias_registrar", { p_tenant_id: a.tenantId, p_subscription_id: a.subscriptionId, p_limite_mes: a.limite, p_cupom: a.cupom, p_inicio: a.inicio }),
    ligarModulo: (t, l) => rpc("fiscal_definir_modulo_guias", { p_tenant_id: t, p_ligado: true, p_limite_mes: l }),
    desligar: (t) => rpc("fiscal_guias_desligar", { p_tenant_id: t }),
    cancelamentoPedido: async (t, s) => { await rpc("fiscal_guias_cancelamento_pedido", { p_tenant_id: t, p_subscription_id: s }); },
    validarCupom: (t, c) => rpc("fiscal_validar_cupom", { p_tenant_id: t, p_codigo: c, p_plano: "guias" }),
  };
}

const ligar = (pg, tenantId, extra = {}, autorizado = true) =>
  processarGuias({ metodo: "POST", autorizado, body: { acao: "ligar", tenant_id: tenantId, limite_mes: 500, ...extra } }, depsGuias(pg));

/** Escritório (conta-mãe, faixa 5) com a principal no banco e no dublê do Pagar.me, como a Bragantina. */
async function escritorio(pg, { status = "future", cartao = true, statusBanco = "pendente" } = {}) {
  const e = await criarEmpresa(bancos.dono);
  empresas.push(e);
  await bancos.dono.query(`update nofiscal.fiscal_tenants set plan = 'escritorio_5', monthly_note_limit = 500 where id = $1`, [e.tenantId]);
  const principal = `sub_principal_${randomBytes(6).toString("hex")}`;
  await bancos.dono.query(
    `insert into nofiscal.fiscal_subscriptions (tenant_id, plano, com_teste, pagarme_subscription_id, status, aceite_em, aceite_texto)
     values ($1, 'escritorio_5', true, $2, $3, now(), 'aceite')`,
    [e.tenantId, principal, statusBanco],
  );
  pg.subs.set(principal, {
    id: principal, status, start_at: FIM_DO_TESTE, next_billing_at: null,
    customer: { id: "cus_Jr0wBjdC1UPbwd6E" }, card: cartao ? { id: "card_bragantina", status: "active" } : null,
  });
  return { ...e, principal };
}

const addon = async (t) => (await bancos.dono.query(`select * from nofiscal.fiscal_addons where tenant_id = $1 and produto = 'guias'`, [t])).rows[0];

const BASIC = `Basic ${btoa("u:p")}`;
const aviso = (tipo, data, extra = {}) =>
  processarAviso(
    { metodo: "POST", authorization: BASIC, body: { id: `hook_${randomUUID()}`, type: tipo, created_at: extra.em ?? new Date().toISOString(), data } },
    { env: { PAGARME_FISCAL_WEBHOOK_USER: "u", PAGARME_FISCAL_WEBHOOK_PASS: "p" }, aplicarEvento: banco.aplicarEvento, medirCobranca: extra.medir },
  );

function ciclo(pg, vencidas = []) {
  return processarCiclo({ metodo: "POST", segredo: "s" }, {
    env: ENV,
    fetch: pg.fetch,
    segredoOk: async () => true,
    vencidas: async () => vencidas,
    guiasComPrincipal: async (t) => { await rpc("fiscal_guias_cancelar_com_principal", { p_tenant_id: t }); },
    guiasPendentes: async (l) => {
      const { rows } = await bancos.servico.query("select * from public.fiscal_guias_cancelamentos_pendentes($1)", [l]);
      return rows;
    },
    guiasCancelamentoPedido: async (t, s) => { await rpc("fiscal_guias_cancelamento_pedido", { p_tenant_id: t, p_subscription_id: s }); },
  });
}

before(async () => {
  // Cupom da migração; nos testes o limite de usos não pode atrapalhar.
  await bancos.dono.query(`update nofiscal.fiscal_cupons set max_usos = null where codigo = 'FUNDADORGUIAS'`);
  // Cupom só do Escritório (como o FUNDADOR5): não vale para a Guias.
  await bancos.dono.query(
    `insert into nofiscal.fiscal_cupons (codigo, tipo, valor, ciclos, planos) values ('TESTEGUIASESC5', 'valor', 5000, 12, array['escritorio_5'])
     on conflict (codigo) do nothing`,
  );
});

after(async () => {
  for (const e of empresas) {
    const { rows } = await bancos.dono.query(`select pagarme_subscription_id from nofiscal.fiscal_addons where tenant_id = $1`, [e.tenantId]);
    await bancos.dono.query("delete from nofiscal.fiscal_subscription_events where pagarme_subscription_id = any($1)", [rows.map((r) => r.pagarme_subscription_id)]);
    await apagarEmpresa(bancos.dono, e);
  }
  await bancos.dono.query(
    `update nofiscal.fiscal_cupons c set max_usos = 20, usos = (select count(*) from nofiscal.fiscal_cupom_usos u where u.cupom_id = c.id)
      where codigo = 'FUNDADORGUIAS'`,
  );
  await bancos.dono.query(`delete from nofiscal.fiscal_cupons where codigo = 'TESTEGUIASESC5'`);
  await bancos.fechar();
});

test("G1: plano nó.fiscal Guias mensal, R$ 197,00, sem teste, fatura NOFISCALGUIAS; o script só roda com sk_ de produção", async () => {
  const p = corpoDoPlanoGuias();
  assert.equal(p.name, "nó.fiscal Guias");
  assert.equal(p.interval, "month");
  assert.equal(p.statement_descriptor, "NOFISCALGUIAS");
  assert.ok(p.statement_descriptor.length <= 13);
  assert.equal("trial_period_days" in p, false);
  assert.deepEqual(p.items, [{ name: "nó.fiscal Guias", quantity: 1, pricing_scheme: { scheme_type: "unit", price: 19700 } }]);
  assert.equal(PLANO_GUIAS.env, "PAGARME_PLANO_FISCAL_GUIAS_ID");
  await assert.rejects(criarPlanoGuias({ fetch: async () => { throw new Error("não devia chamar"); }, env: { PAGARME_SECRET_KEY: "sk_test_x" } }), /CHAVE_NAO_PRODUCAO/);
  const enviados = [];
  const r = await criarPlanoGuias({
    env: { PAGARME_SECRET_KEY: "sk_prod_x", PAGARME_ASSINATURA_API_URL: API },
    fetch: async (url, init) => { enviados.push({ url, corpo: JSON.parse(init.body) }); return new Response(JSON.stringify({ id: "plan_abc" }), { status: 200 }); },
  });
  assert.deepEqual(r, { env: "PAGARME_PLANO_FISCAL_GUIAS_ID", id: "plan_abc" });
  assert.equal(enviados[0].url, `${API}/plans`);
  assert.deepEqual(enviados[0].corpo, p);
});

test("G3: só a nó liga (service role); conta que não é conta-mãe de Escritório é recusada", async () => {
  assert.equal(await autorizadoServico("Bearer chave", "chave"), true);
  assert.equal(await autorizadoServico("Bearer outra", "chave"), false);
  assert.equal(await autorizadoServico("Bearer ", undefined), false);
  const pg = pagarme();
  const e = await escritorio(pg);
  assert.equal((await ligar(pg, e.tenantId, {}, false)).http, 401);
  assert.equal(pg.chamadas.length, 0);
  await bancos.dono.query(`update nofiscal.fiscal_tenants set plan = 'pro' where id = $1`, [e.tenantId]);
  const r = await ligar(pg, e.tenantId);
  assert.equal(r.body.error_code, "NAO_E_CONTA_MAE_DE_ESCRITORIO");
  await bancos.dono.query(`update nofiscal.fiscal_tenants set plan = 'escritorio_5' where id = $1`, [e.tenantId]);
});

test("G2/G3/G7: cria no cartão da principal, começando no fim do teste dela, com FUNDADORGUIAS (R$ 147 por 12 ciclos), e liga o módulo", async () => {
  const pg = pagarme();
  const e = await escritorio(pg);
  const r = await ligar(pg, e.tenantId, { cupom: "fundadorguias" });
  assert.equal(r.http, 201, JSON.stringify(r.body));
  assert.equal(r.body.inicio, FIM_DO_TESTE);
  assert.equal(r.body.valor_com_desconto_centavos, 14700);
  assert.equal(r.body.desconto_ciclos, 12);
  const get = pg.chamadas.find((c) => c.metodo === "GET");
  assert.equal(get.caminho, `/subscriptions/${e.principal}`);
  const post = pg.chamadas.find((c) => c.metodo === "POST");
  assert.deepEqual(post.corpo, {
    plan_id: "plan_guias_teste",
    customer_id: "cus_Jr0wBjdC1UPbwd6E",
    card_id: "card_bragantina",
    payment_method: "credit_card",
    start_at: FIM_DO_TESTE,
    discounts: [{ value: 5000, discount_type: "flat", cycles: 12 }],
    metadata: { origem: "agente-fiscal", produto: "guias", tenant_id: e.tenantId, limite_mes: 500, geracao: 0, cupom: "FUNDADORGUIAS" },
  });
  assert.ok(post.headers["Idempotency-Key"].startsWith(`nofiscal-guias-${e.tenantId}-`));
  const a = await addon(e.tenantId);
  assert.equal(a.pagarme_subscription_id, r.body.pagarme_subscription_id);
  assert.equal(a.status, "ativo");
  assert.equal(a.pagarme_status, "pendente");
  assert.equal(a.limite_mes, 500);
  assert.equal(new Date(a.proxima_cobranca).toISOString(), FIM_DO_TESTE);
  assert.equal(a.desconto_valor, 5000);
  assert.equal(a.desconto_ciclos, 12);
  const { rows: cob } = await bancos.dono.query("select nofiscal.guias_cobranca($1) as c, nofiscal.guias_ligado($1) as l", [e.tenantId]);
  assert.equal(cob[0].l, true);
  assert.deepEqual(cob[0].c, { valor_centavos: 19700, valor_atual_centavos: 14700, desconto_ciclos_restantes: 12, proxima_cobranca: cob[0].c.proxima_cobranca, status: "pendente" });
  const usos = await bancos.dono.query(
    `select count(*)::int as n from nofiscal.fiscal_cupom_usos u join nofiscal.fiscal_cupons c on c.id = u.cupom_id where c.codigo = 'FUNDADORGUIAS' and u.tenant_id = $1`,
    [e.tenantId],
  );
  assert.equal(usos.rows[0].n, 1);
});

test("G7: idempotência — chamar de novo (ou duas vezes ao mesmo tempo) não cria outra assinatura", async () => {
  const pg = pagarme();
  const e = await escritorio(pg);
  const [x, y] = await Promise.all([ligar(pg, e.tenantId), ligar(pg, e.tenantId)]);
  const posts = () => pg.chamadas.filter((c) => c.metodo === "POST").length;
  assert.equal(posts(), 1, JSON.stringify([x.body, y.body]));
  const z = await ligar(pg, e.tenantId);
  assert.equal(z.http, 200);
  assert.equal(z.body.ja_existia, true);
  assert.equal(posts(), 1);
  assert.equal(z.body.pagarme_subscription_id, (await addon(e.tenantId)).pagarme_subscription_id);
});

test("G3/G7: recusa sem cartão, com a principal cancelada no Pagar.me ou no banco, e cupom de outro produto — nada fica ligado", async () => {
  const pg = pagarme();
  const semCartao = await escritorio(pg, { cartao: false });
  assert.equal((await ligar(pg, semCartao.tenantId)).body.error_code, "SEM_CARTAO");
  const cancelada = await escritorio(pg, { status: "canceled" });
  assert.equal((await ligar(pg, cancelada.tenantId)).body.error_code, "PRINCIPAL_INATIVA");
  const noBanco = await escritorio(pg, { statusBanco: "cancelada" });
  assert.equal((await ligar(pg, noBanco.tenantId)).body.error_code, "SEM_ASSINATURA_PRINCIPAL");
  const outroCupom = await escritorio(pg);
  assert.equal((await ligar(pg, outroCupom.tenantId, { cupom: "TESTEGUIASESC5" })).body.error_code, "CUPOM_PLANO");
  assert.equal(pg.chamadas.filter((c) => c.metodo === "POST").length, 0);
  for (const e of [semCartao, cancelada, noBanco, outroCupom]) {
    const a = await addon(e.tenantId);
    assert.ok(!a || (a.status === "desligado" && a.pagarme_subscription_id === null && a.pagarme_status === null), JSON.stringify(a));
  }
  // Depois de recusar, dá para ligar quando o cartão aparece.
  pg.subs.get(semCartao.principal).card = { id: "card_novo", status: "active" };
  assert.equal((await ligar(pg, semCartao.tenantId)).http, 201);
});

test("G4: desligar cancela a Guias no Pagar.me; se o Pagar.me falhar, o ciclo cancela depois", async () => {
  const pg = pagarme();
  const e = await escritorio(pg);
  const sub = (await ligar(pg, e.tenantId)).body.pagarme_subscription_id;
  const r = await processarGuias({ metodo: "POST", autorizado: true, body: { acao: "desligar", tenant_id: e.tenantId } }, depsGuias(pg));
  assert.equal(r.body.cancelamento, "pedido");
  assert.equal(pg.subs.get(sub).status, "canceled");
  let a = await addon(e.tenantId);
  assert.equal(a.status, "desligado");
  assert.equal(a.pagarme_status, "cancelamento_pedido");
  assert.equal(a.cancelar_no_gateway, false);

  const e2 = await escritorio(pg);
  const sub2 = (await ligar(pg, e2.tenantId)).body.pagarme_subscription_id;
  pg.falhar.delete = true;
  const r2 = await processarGuias({ metodo: "POST", autorizado: true, body: { acao: "desligar", tenant_id: e2.tenantId } }, depsGuias(pg));
  assert.equal(r2.body.cancelamento, "fica_para_o_ciclo");
  assert.equal((await addon(e2.tenantId)).cancelar_no_gateway, true);
  pg.falhar.delete = false;
  const c = await ciclo(pg);
  assert.ok(c.body.guias_canceladas >= 1);
  assert.equal(pg.subs.get(sub2).status, "canceled");
  a = await addon(e2.tenantId);
  assert.equal(a.pagarme_status, "cancelamento_pedido");
  // O aviso subscription.canceled da Guias fecha: cancelada.
  await aviso("subscription.canceled", { id: sub2, status: "canceled" });
  assert.equal((await addon(e2.tenantId)).pagarme_status, "cancelada");
  // Desligar também pela função da nó no SQL marca o cancelamento.
  const e3 = await escritorio(pg);
  await ligar(pg, e3.tenantId);
  await rpc("fiscal_definir_modulo_guias", { p_tenant_id: e3.tenantId, p_ligado: false, p_limite_mes: null });
  assert.equal((await addon(e3.tenantId)).cancelar_no_gateway, true);
});

test("G4: principal cancelada (webhook ou ciclo) cancela a Guias e desliga o módulo", async () => {
  const pg = pagarme();
  const e = await escritorio(pg);
  const sub = (await ligar(pg, e.tenantId)).body.pagarme_subscription_id;
  const r = await aviso("subscription.canceled", { id: e.principal, status: "canceled" });
  assert.equal(r.http, 200);
  let a = await addon(e.tenantId);
  assert.equal(a.status, "desligado");
  assert.equal(a.cancelar_no_gateway, true);
  await ciclo(pg);
  assert.equal(pg.subs.get(sub).status, "canceled");
  assert.equal((await addon(e.tenantId)).pagarme_status, "cancelamento_pedido");

  // Pelo ciclo: cancelamento agendado vencido da principal leva a Guias na mesma rodada.
  const e2 = await escritorio(pg);
  const sub2 = (await ligar(pg, e2.tenantId)).body.pagarme_subscription_id;
  const c = await ciclo(pg, [{ id: randomUUID(), tenant_id: e2.tenantId, pagarme_subscription_id: e2.principal, cancelamento_agendado_para: new Date().toISOString() }]);
  assert.equal(c.body.canceladas, 1);
  assert.equal(pg.subs.get(e2.principal).status, "canceled");
  assert.equal(pg.subs.get(sub2).status, "canceled");
  a = await addon(e2.tenantId);
  assert.equal(a.status, "desligado");
  assert.equal(a.pagarme_status, "cancelamento_pedido");
});

test("G5: webhooks da Guias — paga, recusada (bloqueia o módulo), paga de novo (desbloqueia), cancelada; a principal segue igual", async () => {
  const pg = pagarme();
  const e = await escritorio(pg);
  const sub = (await ligar(pg, e.tenantId, { cupom: "FUNDADORGUIAS" })).body.pagarme_subscription_id;
  const medidas = [];
  const medir = async (a) => { medidas.push(a); return { resultado: "ok" }; };
  const t0 = Date.parse(FIM_DO_TESTE);
  const paga = await aviso("invoice.paid", { id: "in_g1", amount: 14700, subscription: { id: sub } }, { em: new Date(t0 + 60_000).toISOString(), medir });
  assert.equal(paga.body.produto, "guias");
  let a = await addon(e.tenantId);
  assert.equal(a.pagarme_status, "paga");
  assert.equal(a.ciclos_pagos, 1);
  assert.equal(new Date(a.proxima_cobranca).toISOString().slice(0, 10), "2027-01-16");
  assert.equal(medidas.length, 0, "a cobrança da Guias não é medida como compra do plano");

  await aviso("invoice.payment_failed", { id: "in_g2", subscription: { id: sub } }, { em: new Date(t0 + 31 * 86400_000).toISOString() });
  assert.equal((await addon(e.tenantId)).pagarme_status, "recusada");
  const { rows } = await bancos.dono.query("select nofiscal.guias_bloqueio($1) as b", [e.tenantId]);
  assert.equal(rows[0].b, "PAGAMENTO_RECUSADO");
  await assert.rejects(
    bancos.dono.query("select nofiscal.guias_disparar($1, array[gen_random_uuid()], null)", [e.userId]),
    /GUIAS_BLOQUEADO/,
  );
  // A principal não foi tocada.
  const principal = await bancos.dono.query(`select status from nofiscal.fiscal_subscriptions where pagarme_subscription_id = $1`, [e.principal]);
  assert.equal(principal.rows[0].status, "pendente");

  await aviso("invoice.paid", { id: "in_g3", subscription: { id: sub } }, { em: new Date(t0 + 32 * 86400_000).toISOString() });
  assert.equal((await bancos.dono.query("select nofiscal.guias_bloqueio($1) as b", [e.tenantId])).rows[0].b, null);
  // Fora de ordem: um aviso velho não volta a recusar.
  await aviso("invoice.payment_failed", { id: "in_g0", subscription: { id: sub } }, { em: new Date(t0).toISOString() });
  assert.equal((await addon(e.tenantId)).pagarme_status, "paga");

  await aviso("subscription.canceled", { id: sub, status: "canceled" });
  a = await addon(e.tenantId);
  assert.equal(a.pagarme_status, "cancelada");
  assert.equal(a.status, "desligado");
  // Cancelada é final.
  await aviso("invoice.paid", { id: "in_g4", subscription: { id: sub } });
  assert.equal((await addon(e.tenantId)).pagarme_status, "cancelada");

  // Principal: invoice.paid continua mudando a principal e medindo.
  await aviso("invoice.paid", { id: "in_p1", amount: 24700, subscription: { id: e.principal } }, { medir });
  assert.equal((await bancos.dono.query(`select status from nofiscal.fiscal_subscriptions where pagarme_subscription_id = $1`, [e.principal])).rows[0].status, "paga");
  assert.equal(medidas.length, 1);
});

test("G5: aviso da Guias antes de o id ser gravado é reconhecido pela metadata", async () => {
  const pg = pagarme();
  const e = await escritorio(pg);
  await rpc("fiscal_guias_reservar", { p_tenant_id: e.tenantId, p_limite_mes: 500 });
  const sub = `sub_guias_${randomBytes(4).toString("hex")}`;
  const r = await aviso("invoice.paid", { id: "in_m1", subscription: { id: sub, metadata: { produto: "guias", tenant_id: e.tenantId, geracao: 0 } } });
  assert.equal(r.body.produto, "guias");
  const a = await addon(e.tenantId);
  assert.equal(a.pagarme_subscription_id, sub);
  assert.equal(a.pagarme_status, "paga");
});

test("revisão 1: desligar e religar cria uma Guias nova; com o cancelamento ainda pendente, recusa até o ciclo cancelar", async () => {
  const pg = pagarme();
  const e = await escritorio(pg);
  const antiga = (await ligar(pg, e.tenantId)).body.pagarme_subscription_id;
  await processarGuias({ metodo: "POST", autorizado: true, body: { acao: "desligar", tenant_id: e.tenantId } }, depsGuias(pg));
  const r = await ligar(pg, e.tenantId);
  assert.equal(r.http, 201, JSON.stringify(r.body));
  assert.notEqual(r.body.pagarme_subscription_id, antiga);
  const a = await addon(e.tenantId);
  assert.equal(a.status, "ativo");
  assert.equal(a.pagarme_status, "pendente");
  assert.equal(a.pagarme_subscription_id, r.body.pagarme_subscription_id);
  assert.equal(a.geracao, 1);
  const chaves = pg.chamadas.filter((c) => c.metodo === "POST").map((c) => c.headers["Idempotency-Key"]);
  assert.equal(new Set(chaves).size, 2, "geração nova, chave nova");

  const e2 = await escritorio(pg);
  await ligar(pg, e2.tenantId);
  pg.falhar.delete = true;
  await processarGuias({ metodo: "POST", autorizado: true, body: { acao: "desligar", tenant_id: e2.tenantId } }, depsGuias(pg));
  pg.falhar.delete = false;
  const pendente = await ligar(pg, e2.tenantId);
  assert.equal(pendente.body.error_code, "CANCELAMENTO_PENDENTE");
  assert.equal((await addon(e2.tenantId)).status, "desligado");
  await ciclo(pg);
  assert.equal((await ligar(pg, e2.tenantId)).http, 201);
});

test("revisão 2: aviso atrasado de uma Guias anterior não pega a reserva nova", async () => {
  const pg = pagarme();
  const e = await escritorio(pg);
  const antiga = (await ligar(pg, e.tenantId)).body.pagarme_subscription_id;
  await processarGuias({ metodo: "POST", autorizado: true, body: { acao: "desligar", tenant_id: e.tenantId } }, depsGuias(pg));
  await aviso("subscription.canceled", { id: antiga, status: "canceled", metadata: { produto: "guias", tenant_id: e.tenantId, geracao: 0 } });
  await rpc("fiscal_guias_reservar", { p_tenant_id: e.tenantId, p_limite_mes: 500 });
  // Reenvio atrasado da antiga (geração 0) com a reserva da geração 1 aberta.
  const r = await aviso("invoice.payment_failed", { id: "in_velha", subscription: { id: antiga, metadata: { produto: "guias", tenant_id: e.tenantId, geracao: 0 } } });
  assert.notEqual(r.body.produto, "guias");
  const a = await addon(e.tenantId);
  assert.equal(a.pagarme_subscription_id, null);
  assert.equal(a.pagarme_status, "criando");
});

test("revisão 3: Guias recusada já na criação é cancelada e não liga nada; sem start_at a próxima cobrança vem do Pagar.me", async () => {
  const pg = pagarme();
  const e = await escritorio(pg, { status: "active" });
  pg.subs.get(e.principal).next_billing_at = null;
  pg.subs.get(e.principal).start_at = "2026-01-01T00:00:00Z";
  const fetchOriginal = pg.fetch;
  const recusar = { sim: true };
  pg.fetch = async (url, init = {}) => {
    const res = await fetchOriginal(url, init);
    if ((init.method || "GET") === "POST") {
      const j = await res.json();
      pg.subs.get(j.id).status = recusar.sim ? "failed" : "active";
      pg.subs.get(j.id).next_billing_at = "2026-12-19T15:00:00.000Z";
      return new Response(JSON.stringify(pg.subs.get(j.id)), { status: 200 });
    }
    return res;
  };
  const r = await ligar(pg, e.tenantId);
  assert.equal(r.http, 402);
  assert.equal(r.body.error_code, "PAGAMENTO_RECUSADO");
  assert.ok(pg.chamadas.some((c) => c.metodo === "DELETE"));
  const a = await addon(e.tenantId);
  assert.equal(a.status, "desligado");
  assert.equal(a.pagarme_subscription_id, null);
  recusar.sim = false;
  const ok = await ligar(pg, e.tenantId);
  assert.equal(ok.http, 201);
  assert.equal("start_at" in pg.chamadas.filter((c) => c.metodo === "POST").at(-1).corpo, false);
  assert.equal(new Date((await addon(e.tenantId)).proxima_cobranca).toISOString(), "2026-12-19T15:00:00.000Z");
});

test("revisão: desligado enquanto a Guias nascia — não liga e cancela a recém-criada; cupom percentual é recusado", async () => {
  const pg = pagarme();
  const e = await escritorio(pg);
  const deps = depsGuias(pg);
  const registrar = deps.registrar;
  deps.registrar = async (a) => {
    await rpc("fiscal_definir_modulo_guias", { p_tenant_id: e.tenantId, p_ligado: false, p_limite_mes: null });
    return registrar(a);
  };
  const r = await processarGuias({ metodo: "POST", autorizado: true, body: { acao: "ligar", tenant_id: e.tenantId } }, deps);
  assert.equal(r.body.error_code, "DESLIGADO_DURANTE_A_CRIACAO");
  const a = await addon(e.tenantId);
  assert.equal(a.status, "desligado");
  assert.equal(pg.subs.get(a.pagarme_subscription_id).status, "canceled");
  assert.equal(a.pagarme_status, "cancelamento_pedido");

  await bancos.dono.query(`insert into nofiscal.fiscal_cupons (codigo, tipo, valor, planos) values ('TESTEGUIASPCT', 'percentual', 10, array['guias']) on conflict do nothing`);
  const e2 = await escritorio(pg);
  assert.equal((await ligar(pg, e2.tenantId, { cupom: "TESTEGUIASPCT" })).body.error_code, "CUPOM_INVALIDO");
  await bancos.dono.query(`delete from nofiscal.fiscal_cupons where codigo = 'TESTEGUIASPCT'`);
});
