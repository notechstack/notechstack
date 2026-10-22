// Provas de C12, C13 e C35–C37 de .checks/agente-fiscal-whatsapp.md (lote C).
// Checkout e webhook passam pelo núcleo das edge functions e pelas quatro funções `public.fiscal_*`
// no banco local, com o papel `service_role`. O Pagar.me é um dublê: nenhuma chamada real.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  TEXTO_ACEITE_FISCAL,
  corpoDoPlano,
  processarCheckout,
} from "../../supabase/functions/assinatura-fiscal/core.ts";
import { processarAviso } from "../../supabase/functions/assinatura-fiscal-webhook/core.ts";
import {
  abrirBancos,
  apagarEmpresa,
  apagarEventos,
  apagarReivindicacoes,
  cpfAleatorio,
  criarEmpresa,
  emailAleatorio,
  funcoesDoBanco,
  telefoneAleatorio,
  cnpjAleatorio,
} from "./banco.mjs";

const SAL = "sal-fixo-do-teste";
const MSG_RETESTE = "Este CNPJ, e-mail ou telefone já usou o teste grátis";
const DIA = 24 * 3600 * 1000;
const API = "https://pagarme.simulado/core/v5";

const ENV = {
  PAGARME_ASSINATURA_SECRET_KEY: "sk_test_x",
  PAGARME_ASSINATURA_API_URL: `${API}/`,
  PAGARME_ASSINATURA_AMBIENTE: "sandbox",
  PAGARME_PLANO_FISCAL_INICIAL_ID: "plan_inicial_teste",
  PAGARME_PLANO_FISCAL_PRO_ID: "plan_pro_teste",
  PAGARME_PLANO_FISCAL_INICIAL_SEM_TESTE_ID: "plan_inicial_sem_teste",
  PAGARME_PLANO_FISCAL_PRO_SEM_TESTE_ID: "plan_pro_sem_teste",
  FISCAL_VENDA_ABERTA: "sim",
  FISCAL_TRIAL_SALT: SAL,
};
const WEBHOOK_ENV = { PAGARME_FISCAL_WEBHOOK_USER: "pagarme", PAGARME_FISCAL_WEBHOOK_PASS: "senha-do-webhook" };
const BASIC = `Basic ${Buffer.from("pagarme:senha-do-webhook").toString("base64")}`;

const ENDERECO = { cep: "01001-000", rua: "Praça da Sé", numero: "100", bairro: "Sé", cidade: "São Paulo", uf: "sp" };

// Hash calculado aqui, à parte: sha256(sal + valor normalizado), em hex.
const sha256 = (texto) => createHash("sha256").update(texto, "utf8").digest("hex");

const bancos = abrirBancos();
const banco = funcoesDoBanco(bancos.servico);
const empresas = [];
const reivindicacoes = [];
const assinaturas = [];

async function empresa(opcoes) {
  const e = await criarEmpresa(bancos.dono, opcoes);
  e.cpf = cpfAleatorio();
  empresas.push(e);
  reivindicacoes.push(hashesDe(e));
  return e;
}

function hashesDe(e) {
  return {
    cpf: sha256(SAL + e.cpf),
    cnpj: sha256(SAL + e.cnpj),
    email: sha256(SAL + e.email.trim().toLowerCase()),
    phone: sha256(SAL + e.telefone),
  };
}

function pedido(e, extra = {}) {
  return {
    plano: "inicial",
    cpf: e.cpf,
    card_token: "token_abc123",
    endereco: { ...ENDERECO },
    termos_aceite: true,
    aceite_texto: TEXTO_ACEITE_FISCAL,
    ...extra,
  };
}

function pagarme({ status = "future", http = 200 } = {}) {
  const chamadas = [];
  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    chamadas.push({ url, method: init.method, body });
    if (init.method === "DELETE") return { ok: true, status: 200, json: async () => ({ status: "canceled" }) };
    const id = `sub_${randomBytes(8).toString("hex")}`;
    assinaturas.push(id);
    return { ok: http < 300, status: http, json: async () => ({ id, status, customer: { id: "cus_teste" } }) };
  };
  return { fetch, chamadas };
}

async function checkout(e, body, { env = {}, gateway = pagarme(), sessao = e?.userId ?? null, deps = {} } = {}) {
  const r = await processarCheckout(body, {
    env: { ...ENV, ...env },
    fetch: gateway.fetch,
    sessao: async () => sessao,
    contexto: banco.contexto,
    reivindicarTeste: banco.reivindicarTeste,
    registrar: banco.registrar,
    log: () => {},
    ...deps,
  });
  return { ...r, chamadas: gateway.chamadas };
}

async function aviso(id, tipo, subscriptionId, createdAt) {
  return processarAviso(
    {
      metodo: "POST",
      authorization: BASIC,
      body: { id, type: tipo, ...(createdAt ? { created_at: createdAt } : {}), data: { subscription: { id: subscriptionId } } },
    },
    { env: WEBHOOK_ENV, aplicarEvento: banco.aplicarEvento, log: () => {} },
  );
}

async function assinaturaDe(e) {
  const { rows } = await bancos.dono.query(
    `select plano, com_teste, status, aceite_em, aceite_texto, pagarme_subscription_id, pagarme_customer_id
       from nofiscal.fiscal_subscriptions where tenant_id = $1`,
    [e.tenantId],
  );
  return rows;
}

async function tenantDe(e) {
  const { rows } = await bancos.dono.query(
    "select plan, monthly_note_limit, trial_ends_at from nofiscal.fiscal_tenants where id = $1", [e.tenantId]);
  return rows[0];
}

async function bloqueio(e) {
  const { rows } = await bancos.dono.query("select nofiscal.emission_block($1) as b", [e.tenantId]);
  return rows[0].b;
}

async function reivindicados(hashes) {
  const { rows } = await bancos.dono.query(
    "select kind from nofiscal.fiscal_trial_claims where (kind, hash) in (select * from jsonb_each_text($1::jsonb)) order by kind",
    [JSON.stringify(hashes)],
  );
  return rows.map((r) => r.kind);
}

test.after(async () => {
  for (const e of empresas) await apagarEmpresa(bancos.dono, e);
  await apagarEventos(bancos.dono, assinaturas);
  for (const h of reivindicacoes) await apagarReivindicacoes(bancos.dono, h);
  await bancos.fechar();
});

test("primeira assinatura com 7 dias de teste", async () => {
  // O par com teste tem trial_period_days = 7; o par sem teste não tem o campo.
  assert.equal(corpoDoPlano("inicial").trial_period_days, 7);
  assert.equal(corpoDoPlano("pro").trial_period_days, 7);
  assert.equal(Object.hasOwn(corpoDoPlano("inicial_sem_teste"), "trial_period_days"), false);
  assert.equal(Object.hasOwn(corpoDoPlano("pro_sem_teste"), "trial_period_days"), false);

  for (const [plano, planId, limite] of [["inicial", "plan_inicial_teste", 20], ["pro", "plan_pro_teste", 100]]) {
    const e = await empresa();
    const antes = Date.now();
    const r = await checkout(e, pedido(e, { plano }));
    const depois = Date.now();

    assert.equal(r.http, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.com_teste, true);
    assert.equal(r.body.status, "pendente");
    assert.equal(Object.hasOwn(r.body, "aviso"), false);

    // Uma chamada só: a criação da assinatura no plano com teste, com cartão e sem start_at.
    assert.equal(r.chamadas.length, 1);
    const [criacao] = r.chamadas;
    assert.equal(criacao.method, "POST");
    assert.equal(criacao.url, `${API}/subscriptions`);
    assert.equal(criacao.body.plan_id, planId);
    assert.equal(criacao.body.payment_method, "credit_card");
    assert.equal(criacao.body.card_token, "token_abc123");
    assert.equal(Object.hasOwn(criacao.body, "start_at"), false);
    assert.equal(criacao.body.customer.document, e.cnpj);
    assert.equal(criacao.body.customer.type, "company");
    assert.equal(criacao.body.customer.email, e.email);

    // trial_ends_at = fim dos 7 dias, gravado no tenant.
    const fim = Date.parse(r.body.trial_ends_at);
    assert.ok(fim >= antes + 7 * DIA && fim <= depois + 7 * DIA, `trial_ends_at fora dos 7 dias: ${r.body.trial_ends_at}`);
    const t = await tenantDe(e);
    assert.equal(t.trial_ends_at.getTime(), fim);
    assert.equal(t.plan, plano);
    assert.equal(t.monthly_note_limit, limite);

    // Nada cobrado: a assinatura fica pendente (só o aviso de cobrança a deixa paga) e a emissão real
    // está liberada durante o teste.
    const subs = await assinaturaDe(e);
    assert.equal(subs.length, 1);
    assert.equal(subs[0].plano, plano);
    assert.equal(subs[0].com_teste, true);
    assert.equal(subs[0].status, "pendente");
    assert.equal(subs[0].pagarme_customer_id, "cus_teste");
    assert.equal(await bloqueio(e), null);

    // O teste fica reivindicado pelos quatro valores, só em hash.
    assert.deepEqual(await reivindicados(hashesDe(e)), ["cnpj", "cpf", "email", "phone"]);
  }
});

test("reteste vai para o plano sem teste", async () => {
  const outra = await empresa();

  for (const kind of ["cpf", "cnpj", "email", "phone"]) {
    const e = await empresa();
    // Um teste anterior usou só este valor; os outros três são novos.
    const anterior = hashesDe({ cpf: cpfAleatorio(), cnpj: cnpjAleatorio(), email: emailAleatorio(), telefone: telefoneAleatorio() });
    reivindicacoes.push(anterior);
    anterior[kind] = hashesDe(e)[kind];
    assert.equal(await banco.reivindicarTeste(outra.tenantId, anterior), true);

    // O Pro também tem o seu par sem teste.
    const [plano, planId] = kind === "cpf" ? ["pro", "plan_pro_sem_teste"] : ["inicial", "plan_inicial_sem_teste"];
    const r = await checkout(e, pedido(e, { plano }));
    assert.equal(r.http, 200, `${kind}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.com_teste, false, kind);
    assert.equal(r.body.aviso, MSG_RETESTE, kind);
    assert.equal(r.body.trial_ends_at, null, kind);
    assert.equal(r.chamadas.length, 1);
    assert.equal(r.chamadas[0].body.plan_id, planId, kind);

    const subs = await assinaturaDe(e);
    assert.equal(subs.length, 1);
    assert.equal(subs[0].com_teste, false, kind);
    assert.equal(subs[0].plano, plano);
    assert.equal((await tenantDe(e)).trial_ends_at, null, kind);
    // Cobrança imediata: sem teste, a emissão só libera quando a cobrança for aprovada.
    assert.equal(await bloqueio(e), "PAYMENT_NOT_APPROVED", kind);

    // Os outros valores desta empresa não foram gravados (a reivindicação recusada não grava nada).
    const proprios = hashesDe(e);
    delete proprios[kind];
    assert.deepEqual(await reivindicados(proprios), [], kind);
  }
});

test("cobrança aprovada libera", async () => {
  // Com teste: no 8º dia, sem cobrança aprovada a emissão para; o aviso de cobrança paga a libera.
  const e = await empresa();
  const r = await checkout(e, pedido(e));
  assert.equal(r.http, 200, JSON.stringify(r.body));
  const [sub] = await assinaturaDe(e);
  await bancos.dono.query("update nofiscal.fiscal_tenants set trial_ends_at = now() - interval '1 minute' where id = $1", [e.tenantId]);
  assert.equal(await bloqueio(e), "PAYMENT_NOT_APPROVED");

  const paga = await aviso(`hook_${randomBytes(6).toString("hex")}`, "invoice.paid", sub.pagarme_subscription_id, new Date().toISOString());
  assert.equal(paga.http, 200);
  assert.equal(paga.body.applied, true);
  assert.equal((await assinaturaDe(e))[0].status, "paga");
  assert.equal(await bloqueio(e), null);

  // Sem teste (o e-mail já usou o teste): a cobrança imediata aprovada (charge.paid) libera também.
  const outra = await empresa();
  await bancos.dono.query("update nofiscal.fiscal_accounts set email = $2 where user_id = $1", [outra.userId, e.email]);
  const r2 = await checkout(outra, pedido(outra));
  assert.equal(r2.body.com_teste, false);
  const [sub2] = await assinaturaDe(outra);
  assert.equal(await bloqueio(outra), "PAYMENT_NOT_APPROVED");
  const paga2 = await aviso(`hook_${randomBytes(6).toString("hex")}`, "charge.paid", sub2.pagarme_subscription_id, new Date().toISOString());
  assert.equal(paga2.body.applied, true);
  assert.equal((await assinaturaDe(outra))[0].status, "paga");
  assert.equal(await bloqueio(outra), null);
});

test("aceite obrigatório", async () => {
  const e = await empresa();
  const semAceite = [
    pedido(e, { termos_aceite: undefined }),
    pedido(e, { termos_aceite: false }),
    pedido(e, { termos_aceite: "true" }),
    pedido(e, { aceite_texto: undefined }),
    pedido(e, { aceite_texto: "" }),
    pedido(e, { aceite_texto: "Li e aceito." }),
    pedido(e, { aceite_texto: `${TEXTO_ACEITE_FISCAL} e mais alguma coisa` }),
  ];
  for (const body of semAceite) {
    const r = await checkout(e, body);
    assert.equal(r.http, 400, JSON.stringify(body));
    assert.equal(r.body.error_code, "DADOS_INVALIDOS");
    assert.equal(r.chamadas.length, 0, "sem aceite não chama o Pagar.me");
  }
  assert.deepEqual(await assinaturaDe(e), [], "sem aceite não há assinatura");
  assert.deepEqual(await reivindicados(hashesDe(e)), [], "sem aceite o teste não é gasto");

  // Com o aceite (mesmo com espaços diferentes), grava data e o texto exato da constante.
  const antes = Date.now();
  const r = await checkout(e, pedido(e, { aceite_texto: `  ${TEXTO_ACEITE_FISCAL.replace(/ /g, "  ")} ` }));
  const depois = Date.now();
  assert.equal(r.http, 200, JSON.stringify(r.body));
  const [sub] = await assinaturaDe(e);
  assert.equal(sub.aceite_texto, TEXTO_ACEITE_FISCAL);
  assert.ok(sub.aceite_em.getTime() >= antes - 1000 && sub.aceite_em.getTime() <= depois + 1000, "aceite_em é a hora do aceite");

  // O banco também recusa assinatura sem aceite.
  await assert.rejects(
    banco.registrar({
      tenant_id: e.tenantId, plano: "inicial", com_teste: false, trial_ends_at: null, customer_id: null,
      subscription_id: `sub_${randomBytes(8).toString("hex")}`, status: "pendente", aceite_texto: " ",
    }),
    /aceite obrigatorio/,
  );

  // Texto aprovado (RFC 1 fechada em 22/10/2026): em produção, o checkout chega ao Pagar.me.
  const outra = await empresa();
  const p = await checkout(outra, pedido(outra), { env: { PAGARME_ASSINATURA_AMBIENTE: "producao", PAGARME_ASSINATURA_SECRET_KEY: "sk_live_x" } });
  assert.equal(p.http, 200, JSON.stringify(p.body));
  assert.equal(p.chamadas.length, 1);
});

test("ordem dos avisos", async () => {
  const e = await empresa();
  const r = await checkout(e, pedido(e));
  assert.equal(r.http, 200, JSON.stringify(r.body));
  const [{ pagarme_subscription_id: sub }] = await assinaturaDe(e);
  const status = async () => (await assinaturaDe(e))[0].status;
  const em = (minutos) => new Date(Date.parse("2026-11-01T12:00:00Z") + minutos * 60000).toISOString();
  const id = () => `hook_${randomBytes(6).toString("hex")}`;

  assert.equal((await aviso(id(), "invoice.paid", sub, em(20))).body.applied, true);
  assert.equal(await status(), "paga");

  // Aviso mais antigo que o último aplicado não muda o status.
  const antigo = await aviso(id(), "invoice.payment_failed", sub, em(10));
  assert.equal(antigo.http, 200);
  assert.equal(antigo.body.applied, false);
  assert.equal(antigo.body.ignorado, "fora_de_ordem");
  assert.equal(await status(), "paga");

  // Mais novo muda.
  const repetido = id();
  assert.equal((await aviso(repetido, "charge.payment_failed", sub, em(30))).body.applied, true);
  assert.equal(await status(), "recusada");
  assert.equal(await bloqueio(e), "PAYMENT_NOT_APPROVED");

  // O mesmo aviso de novo não é reaplicado.
  const dup = await aviso(repetido, "charge.payment_failed", sub, em(30));
  assert.equal(dup.http, 200);
  assert.equal(dup.body.duplicado, true);

  assert.equal((await aviso(id(), "subscription.canceled", sub, em(40))).body.applied, true);
  assert.equal(await status(), "cancelada");

  // Cancelada é final: nem um aviso de pagamento mais novo a reabre.
  const depois = await aviso(id(), "invoice.paid", sub, em(50));
  assert.equal(depois.http, 200);
  assert.equal(depois.body.applied, false);
  assert.equal(depois.body.ignorado, "cancelada_final");
  assert.equal(await status(), "cancelada");
  assert.equal(await bloqueio(e), "SUBSCRIPTION_CANCELLED");
});
