// Provas de C10, C12, C13 e C14 (.checks/agente-fiscal-v2.md, lote A): a empresa nasce pelo handler
// real de fiscal-cadastro (fluxo novo: e-mail confirmado, WhatsApp ainda não ativado) e o checkout passa
// pelo núcleo de assinatura-fiscal com as funções public.fiscal_* no banco local. Pagar.me em dublê.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  TEXTO_ACEITE_FISCAL,
  processarCheckout,
  responderConfiguracao,
} from "../../supabase/functions/assinatura-fiscal/core.ts";
import { handle as cadastro } from "../../supabase/functions/fiscal-cadastro/core.ts";
import {
  abrirBancos,
  apagarCadastro,
  apagarReivindicacoes,
  brasilApi,
  cnpjValido,
  cpfValido,
  criarUsuario,
  funcoesDoBanco,
  respostaBrasilApi,
  sha256,
  telefoneAleatorio,
} from "./banco.mjs";

const SAL = "sal-fixo-do-teste";
const MSG_RETESTE = "Este CNPJ, e-mail ou telefone já usou o teste grátis";
const DIA = 24 * 3600 * 1000;
const ENV = {
  PAGARME_ASSINATURA_SECRET_KEY: "sk_test_x",
  PAGARME_ASSINATURA_PUBLIC_KEY: "pk_test_publica",
  PAGARME_ASSINATURA_API_URL: "https://pagarme.simulado/core/v5",
  PAGARME_ASSINATURA_AMBIENTE: "sandbox",
  PAGARME_PLANO_FISCAL_INICIAL_ID: "plan_inicial_teste",
  PAGARME_PLANO_FISCAL_PRO_ID: "plan_pro_teste",
  PAGARME_PLANO_FISCAL_INICIAL_SEM_TESTE_ID: "plan_inicial_sem_teste",
  PAGARME_PLANO_FISCAL_PRO_SEM_TESTE_ID: "plan_pro_sem_teste",
  FISCAL_VENDA_ABERTA: "sim",
  FISCAL_TRIAL_SALT: SAL,
};
const ENDERECO = { cep: "01001-000", rua: "Praça da Sé", numero: "100", bairro: "Sé", cidade: "São Paulo", uf: "SP" };

const bancos = abrirBancos();
const banco = funcoesDoBanco(bancos.servico);
const limpar = [];
const reivindicacoes = [];
test.after(async () => {
  for (const h of reivindicacoes) await apagarReivindicacoes(bancos.dono, h);
  for (const c of limpar) await apagarCadastro(bancos.dono, c);
  await bancos.fechar();
});

// Empresa criada pelo fluxo novo: usuário confirmado pelo código e POST fiscal-cadastro {acao:'criar'}.
async function empresaNova(plano = "inicial") {
  const u = await criarUsuario(bancos.dono);
  const cnpj = cnpjValido();
  const telefone = telefoneAleatorio();
  const e = { userId: u.id, email: u.email, cnpj, telefone, cpf: cpfValido() };
  limpar.push(e);
  const res = await cadastro(new Request("https://funcoes.local/fiscal-cadastro", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sessao" },
    body: JSON.stringify({ acao: "criar", cnpj, razao_social: "Empresa", responsavel: "Dona Teste", telefone, plano }),
  }), {
    env: (k) => ({ CNPJ_API_URL: "https://cnpj.simulado" })[k],
    fetch: brasilApi({ [cnpj]: respostaBrasilApi(cnpj) }).fetch,
    sessao: async () => u.id,
    municipios: async () => null,
    criar: banco.criar,
  });
  assert.equal(res.status, 201);
  e.tenantId = (await res.json()).tenant_id;
  reivindicacoes.push({
    cpf: sha256(SAL + e.cpf), cnpj: sha256(SAL + cnpj), email: sha256(SAL + u.email), phone: sha256(SAL + telefone),
  });
  return e;
}

function pagarme({ status = "future" } = {}) {
  const chamadas = [];
  const fetch = async (url, init = {}) => {
    chamadas.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    if (init.method === "DELETE") return new Response(JSON.stringify({ status: "canceled" }), { status: 200 });
    return new Response(JSON.stringify({ id: `sub_${randomBytes(8).toString("hex")}`, status, customer: { id: "cus_teste" } }), { status: 200 });
  };
  return { fetch, chamadas };
}

async function checkout(e, { gateway = pagarme(), cpf = e.cpf, plano = "inicial" } = {}) {
  const ordem = [];
  const r = await processarCheckout(
    { plano, cpf, card_token: "token_abc123", endereco: { ...ENDERECO }, termos_aceite: true, aceite_texto: TEXTO_ACEITE_FISCAL },
    {
      env: ENV,
      fetch: gateway.fetch,
      sessao: async () => e.userId,
      contexto: banco.contexto,
      reivindicarTeste: banco.reivindicarTeste,
      registrar: async (l) => { ordem.push("registrar"); return banco.registrar(l); },
      marcarPago: async (t) => { ordem.push("marcarPago"); return banco.marcarPago(t); },
      log: () => {},
    },
  );
  return { ...r, chamadas: gateway.chamadas, ordem };
}

async function tenant(e) {
  return (await bancos.dono.query("select onboarding_etapa, pago_em, trial_ends_at from nofiscal.fiscal_tenants where id = $1", [e.tenantId])).rows[0];
}

async function assinaturas(e) {
  return (await bancos.dono.query("select status, com_teste, plano from nofiscal.fiscal_subscriptions where tenant_id = $1", [e.tenantId])).rows;
}

test("configuração do checkout: GET responde 200 com venda_aberta, public_key, aceite_texto e planos 4900/12900", () => {
  const aberta = responderConfiguracao(ENV);
  assert.equal(aberta.http, 200);
  assert.deepEqual(aberta.body, {
    ok: true,
    venda_aberta: true,
    public_key: "pk_test_publica",
    aceite_texto: TEXTO_ACEITE_FISCAL,
    planos: { inicial: { valor_centavos: 4900 }, pro: { valor_centavos: 12900 } },
  });
  const fechada = responderConfiguracao({ ...ENV, FISCAL_VENDA_ABERTA: "" });
  assert.equal(fechada.http, 200);
  assert.equal(fechada.body.venda_aberta, false);
  // Sem segredo nenhum na resposta pública.
  assert.doesNotMatch(JSON.stringify(fechada.body), /sk_test|plan_|sal-fixo/);
});

test("checkout antes da ativação: e-mail confirmado e WhatsApp não ativado assina, e depois do registro grava pago_em e etapa certificado", async () => {
  const e = await empresaNova("pro");
  const conta = (await bancos.dono.query("select email_verified_at, phone_verified_at from nofiscal.fiscal_accounts where user_id = $1", [e.userId])).rows[0];
  assert.ok(conta.email_verified_at);
  assert.equal(conta.phone_verified_at, null);
  assert.equal((await tenant(e)).onboarding_etapa, "pagamento");

  const antes = Date.now();
  const r = await checkout(e, { plano: "pro" });
  assert.equal(r.http, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.com_teste, true);
  const fim = Date.parse(r.body.trial_ends_at);
  assert.ok(fim >= antes + 7 * DIA && fim <= Date.now() + 7 * DIA);
  assert.deepEqual(r.ordem, ["registrar", "marcarPago"]);

  const t = await tenant(e);
  assert.equal(t.onboarding_etapa, "certificado");
  assert.ok(t.pago_em instanceof Date);
  assert.deepEqual(await assinaturas(e), [{ status: "pendente", com_teste: true, plano: "pro" }]);
  assert.equal(r.chamadas[0].body.plan_id, "plan_pro_teste");
  assert.equal(r.chamadas[0].body.customer.document, e.cnpj);
});

test("reteste no fluxo novo: CPF da etapa 1 já usado assina sem teste e devolve o aviso literal", async () => {
  const primeira = await empresaNova();
  assert.equal((await checkout(primeira)).body.com_teste, true);

  // Outra empresa (CNPJ, e-mail e WhatsApp novos) com o mesmo CPF do responsável.
  const segunda = await empresaNova();
  const r = await checkout(segunda, { cpf: primeira.cpf });
  assert.equal(r.http, 200);
  assert.equal(r.body.com_teste, false);
  assert.equal(r.body.aviso, MSG_RETESTE);
  assert.equal(r.body.trial_ends_at, null);
  assert.equal(r.chamadas[0].body.plan_id, "plan_inicial_sem_teste");
  const t = await tenant(segunda);
  assert.equal(t.onboarding_etapa, "certificado");
  assert.ok(t.pago_em);
});

test("cartão recusado: a criação recusada responde 402 PAGAMENTO_RECUSADO e nenhuma assinatura fica registrada", async () => {
  const e = await empresaNova();
  const r = await checkout(e, { gateway: pagarme({ status: "failed" }) });
  assert.equal(r.http, 402);
  assert.equal(r.body.error_code, "PAGAMENTO_RECUSADO");
  assert.deepEqual(await assinaturas(e), []);
  assert.deepEqual(r.ordem, []);
  const t = await tenant(e);
  assert.equal(t.onboarding_etapa, "pagamento");
  assert.equal(t.pago_em, null);
  // A assinatura recusada é cancelada no Pagar.me.
  assert.equal(r.chamadas.at(-1).method, "DELETE");
});
