// Cupons no checkout (migração 20261025090000, pedido de Lucca em 22/10/2026). A empresa nasce pelo handler real
// de fiscal-cadastro e o checkout passa pelo núcleo de assinatura-fiscal com as funções public.fiscal_* no banco
// local. Pagar.me em dublê. Lições do Vault viram provas: restrição por plano (na Prontia a coluna errada a
// deixou morta), a prévia e o checkout dão o mesmo valor, e cortesia sem limite de usos não entra no banco.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  TEXTO_ACEITE_FISCAL,
  processarCheckout,
  processarValidarCupom,
} from "../../supabase/functions/assinatura-fiscal/core.ts";
import { estadoPublico } from "../../supabase/functions/fiscal-conta/core.ts";
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
const cupons = [];
test.after(async () => {
  for (const h of reivindicacoes) await apagarReivindicacoes(bancos.dono, h);
  for (const c of limpar) await apagarCadastro(bancos.dono, c);
  await bancos.dono.query("delete from nofiscal.fiscal_cupons where codigo = any($1)", [cupons]);
  await bancos.fechar();
});

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

async function cupomNovo({ tipo = "percentual", valor, ciclos = null, planos = null, max_usos = null, valido_ate = null, ativo = true }) {
  const codigo = `T${randomBytes(5).toString("hex").toUpperCase()}`;
  cupons.push(codigo);
  await bancos.dono.query(
    `insert into nofiscal.fiscal_cupons (codigo, tipo, valor, ciclos, planos, max_usos, valido_ate, ativo)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [codigo, tipo, valor, ciclos, planos, max_usos, valido_ate, ativo],
  );
  return codigo;
}

function pagarme() {
  const chamadas = [];
  const fetch = async (url, init = {}) => {
    chamadas.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ id: `sub_${randomBytes(8).toString("hex")}`, status: "future", customer: { id: "cus_teste" } }), { status: 200 });
  };
  return { fetch, chamadas };
}

function deps(e, gateway = pagarme(), env = ENV) {
  return {
    env,
    fetch: gateway.fetch,
    sessao: async () => e.userId,
    contexto: banco.contexto,
    reivindicarTeste: banco.reivindicarTeste,
    registrar: banco.registrar,
    marcarPago: banco.marcarPago,
    validarCupom: banco.validarCupom,
    registrarCortesia: banco.registrarCortesia,
    usarCupom: banco.usarCupom,
    log: () => {},
  };
}

const comCartao = (plano, e, cupom) => ({
  plano, cpf: e.cpf, card_token: "token_abc123", endereco: { ...ENDERECO }, termos_aceite: true, aceite_texto: TEXTO_ACEITE_FISCAL, cupom,
});
const semCartao = (plano, cupom) => ({ plano, cupom, termos_aceite: true, aceite_texto: TEXTO_ACEITE_FISCAL });

async function usos(codigo) {
  return (await bancos.dono.query("select usos from nofiscal.fiscal_cupons where codigo = $1", [codigo])).rows[0].usos;
}

test("cupom: a prévia mostra o valor com desconto e não consome o cupom", async () => {
  const e = await empresaNova("pro");
  const codigo = await cupomNovo({ valor: 50, ciclos: 3 });
  const r = await processarValidarCupom({ acao: "validar_cupom", codigo: codigo.toLowerCase(), plano: "pro" }, deps(e));
  assert.equal(r.http, 200);
  assert.deepEqual(r.body.cupom, {
    codigo, descricao: null, tipo: "percentual", valor: 50, cortesia: false, ciclos: 3,
    valor_centavos: 12900, valor_centavos_com_desconto: 6450,
  });
  assert.equal(await usos(codigo), 0);
});

test("cupom: restrição por plano vale na prévia e no checkout", async () => {
  const e = await empresaNova("inicial");
  const codigo = await cupomNovo({ valor: 20, planos: ["pro"] });
  const previa = await processarValidarCupom({ codigo, plano: "inicial" }, deps(e));
  assert.equal(previa.http, 422);
  assert.equal(previa.body.error_code, "CUPOM_PLANO");
  const gateway = pagarme();
  const r = await processarCheckout(comCartao("inicial", e, codigo), deps(e, gateway));
  assert.equal(r.http, 422);
  assert.equal(r.body.error_code, "CUPOM_PLANO");
  assert.equal(gateway.chamadas.length, 0, "nada vai ao Pagar.me");
  assert.equal((await processarValidarCupom({ codigo, plano: "pro" }, deps(e))).http, 200);
});

test("cupom: inexistente, inativo, vencido e esgotado", async () => {
  const e = await empresaNova();
  const casos = [
    ["NAOEXISTE123", "CUPOM_INVALIDO"],
    [await cupomNovo({ valor: 10, ativo: false }), "CUPOM_INVALIDO"],
    [await cupomNovo({ valor: 10, valido_ate: new Date(Date.now() - 60_000) }), "CUPOM_VENCIDO"],
  ];
  const esgotado = await cupomNovo({ valor: 10, max_usos: 1 });
  await bancos.dono.query("update nofiscal.fiscal_cupons set usos = 1 where codigo = $1", [esgotado]);
  casos.push([esgotado, "CUPOM_ESGOTADO"], ["ç!", "CUPOM_INVALIDO"]);
  for (const [codigo, motivo] of casos) {
    const r = await processarValidarCupom({ codigo, plano: "inicial" }, deps(e));
    assert.equal(r.http, 422, codigo);
    assert.equal(r.body.error_code, motivo, codigo);
    assert.ok(r.body.mensagem, codigo);
  }
});

test("cupom: cortesia assina sem cartão e sem Pagar.me, e a empresa segue para o certificado", async () => {
  const e = await empresaNova("pro");
  const codigo = await cupomNovo({ valor: 100, max_usos: 5 });
  const gateway = pagarme();
  const r = await processarCheckout(semCartao("pro", codigo), deps(e, gateway));
  assert.equal(r.http, 200, JSON.stringify(r.body));
  assert.equal(r.body.cortesia, true);
  assert.equal(r.body.status, "paga");
  assert.equal(gateway.chamadas.length, 0, "nenhuma chamada ao Pagar.me");
  const sub = (await bancos.dono.query(
    "select status, origem, plano, desconto_tipo, desconto_valor, pagarme_subscription_id from nofiscal.fiscal_subscriptions where tenant_id = $1",
    [e.tenantId],
  )).rows;
  assert.equal(sub.length, 1);
  assert.equal(sub[0].status, "paga");
  assert.equal(sub[0].origem, "cortesia");
  assert.equal(sub[0].plano, "pro");
  assert.match(sub[0].pagarme_subscription_id, /^cortesia_/);
  const t = (await bancos.dono.query("select onboarding_etapa, plan, monthly_note_limit from nofiscal.fiscal_tenants where id = $1", [e.tenantId])).rows[0];
  assert.deepEqual(t, { onboarding_etapa: "certificado", plan: "pro", monthly_note_limit: 100 });
  assert.equal(await usos(codigo), 1);
  // Cortesia não gasta o teste grátis da empresa.
  const claims = await bancos.dono.query("select count(*)::int as n from nofiscal.fiscal_trial_claims where hash = $1", [sha256(SAL + e.cnpj)]);
  assert.equal(claims.rows[0].n, 0);
  // Emissão liberada: assinatura paga.
  const bloqueio = await bancos.dono.query("select nofiscal.emission_block($1) as b", [e.tenantId]);
  assert.ok(!["NO_SUBSCRIPTION", "PAYMENT_NOT_APPROVED", "SUBSCRIPTION_CANCELLED"].includes(bloqueio.rows[0].b), String(bloqueio.rows[0].b));
  // A mesma empresa não usa o cupom de novo.
  const outra = await processarCheckout(semCartao("pro", codigo), deps(e));
  assert.equal(outra.http, 409);
});

test("cupom: cortesia vale com a venda fechada e com o cartão ausente; cartão junto é recusado", async () => {
  const e = await empresaNova();
  const codigo = await cupomNovo({ valor: 100, max_usos: 5 });
  const comCampoDeCartao = await processarCheckout({ ...semCartao("inicial", codigo), card_number: "4111" }, deps(e));
  assert.equal(comCampoDeCartao.http, 400);
  const r = await processarCheckout(semCartao("inicial", codigo), deps(e, pagarme(), { ...ENV, FISCAL_VENDA_ABERTA: "" }));
  assert.equal(r.http, 200, JSON.stringify(r.body));
  assert.equal(r.body.cortesia, true);
});

test("cupom: desconto vai no corpo da assinatura do Pagar.me e o uso é registrado", async () => {
  const e = await empresaNova("pro");
  const codigo = await cupomNovo({ valor: 50, ciclos: 3 });
  const gateway = pagarme();
  const r = await processarCheckout(comCartao("pro", e, codigo), deps(e, gateway));
  assert.equal(r.http, 200, JSON.stringify(r.body));
  assert.equal(r.body.cupom.valor_centavos_com_desconto, 6450);
  const criar = gateway.chamadas.find((c) => c.method === "POST");
  assert.deepEqual(criar.body.discounts, [{ value: 50, discount_type: "percentage", cycles: 3 }]);
  assert.equal(criar.body.metadata.cupom, codigo);
  const sub = (await bancos.dono.query(
    "select origem, desconto_tipo, desconto_valor, cupom_id is not null as tem_cupom from nofiscal.fiscal_subscriptions where tenant_id = $1",
    [e.tenantId],
  )).rows[0];
  assert.deepEqual(sub, { origem: "pagarme", desconto_tipo: "percentual", desconto_valor: 50, tem_cupom: true });
  assert.equal(await usos(codigo), 1);
});

test("cupom: valor fixo vira desconto flat; valor que zera a mensalidade não vale", async () => {
  const e = await empresaNova();
  const menos20 = await cupomNovo({ tipo: "valor", valor: 2000 });
  const previa = await processarValidarCupom({ codigo: menos20, plano: "inicial" }, deps(e));
  assert.equal(previa.body.cupom.valor_centavos_com_desconto, 2900);
  const gateway = pagarme();
  const r = await processarCheckout(comCartao("inicial", e, menos20), deps(e, gateway));
  assert.equal(r.http, 200, JSON.stringify(r.body));
  assert.deepEqual(gateway.chamadas.find((c) => c.method === "POST").body.discounts, [{ value: 2000, discount_type: "flat" }]);

  const e2 = await empresaNova();
  const zera = await cupomNovo({ tipo: "valor", valor: 4900 });
  const z = await processarValidarCupom({ codigo: zera, plano: "inicial" }, deps(e2));
  assert.equal(z.http, 422);
  assert.equal(z.body.error_code, "CUPOM_PLANO");
});

test("cupom: o banco recusa cortesia sem limite de usos e percentual acima de 100", async () => {
  for (const [tipo, valor, max] of [["percentual", 100, null], ["percentual", 101, 5]]) {
    await assert.rejects(
      bancos.dono.query("insert into nofiscal.fiscal_cupons (codigo, tipo, valor, max_usos) values ($1, $2, $3, $4)", [
        `X${randomBytes(4).toString("hex").toUpperCase()}`, tipo, valor, max,
      ]),
      /check constraint/,
    );
  }
});

test("cupom: cancelar a cortesia encerra na hora, e a página a vê como cortesia", async () => {
  const e = await empresaNova();
  const codigo = await cupomNovo({ valor: 100, max_usos: 5 });
  assert.equal((await processarCheckout(semCartao("inicial", codigo), deps(e))).http, 200);
  const estado = (await bancos.servico.query("select public.fiscal_conta_estado($1) as r", [e.userId])).rows[0].r;
  const publico = estadoPublico(estado);
  assert.equal(publico.assinatura.cortesia, true);
  assert.equal(publico.assinatura.periodo_fim, null);
  const r = (await bancos.servico.query("select public.fiscal_agendar_cancelamento($1, null) as r", [e.userId])).rows[0].r;
  assert.equal(r.status, "agendado");
  assert.equal(r.cancelada_agora, true);
  const sub = (await bancos.dono.query("select status from nofiscal.fiscal_subscriptions where tenant_id = $1", [e.tenantId])).rows[0];
  assert.equal(sub.status, "cancelada");
});
