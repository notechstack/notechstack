import test from "node:test";
import assert from "node:assert/strict";
import {
  TEXTO_ACEITE_ASSINATURA,
  lerConfig,
  processarCheckout,
  respostaGet,
} from "../../supabase/functions/assinatura-auditor/core.ts";

// Tudo simulado: nenhuma chamada real ao Pagar.me, nenhuma chave real.
const ENV = {
  PAGARME_ASSINATURA_SECRET_KEY: "sk_test_x",
  PAGARME_ASSINATURA_PUBLIC_KEY: "pk_test_x",
  PAGARME_ASSINATURA_API_URL: "https://pagarme.simulado/core/v5/",
  PAGARME_ASSINATURA_AMBIENTE: "sandbox",
  PAGARME_PLANO_MENSAL_ID: "plan_mensal",
  PAGARME_PLANO_SEMANAL_ID: "plan_semanal",
  PAGARME_PLANO_AGENCIA_ID: "plan_agencia",
  AUDITOR_VENDA_ABERTA: "sim",
};
const CAMPOS_CARTAO = ["card", "card_number", "number", "cvv", "holder_name", "exp_month", "exp_year"];
const UUID = "00000000-0000-4000-8000-000000000001";

function pedido(extra = {}) {
  return {
    plano: "semanal",
    nome: "  Maria Teste ",
    email: "Maria@Exemplo.com",
    documento: "123.456.789-09",
    telefone: "(11) 98765-4321",
    card_token: "token_abc123",
    termos_aceite: true,
    aceite_texto: TEXTO_ACEITE_ASSINATURA,
    ...extra,
  };
}

function falsos({ env = {}, resposta, redeFalha = false, registrarLanca = false } = {}) {
  const r = resposta ?? { status: 200, body: { id: "sub_x", status: "active", customer: { id: "cus_x" } } };
  const chamadas = { fetch: [], registrar: [], log: [] };
  const deps = {
    env: { ...ENV, ...env },
    fetch: async (url, init = {}) => {
      chamadas.fetch.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
      if (init.method === "DELETE") return { ok: true, status: 200, json: async () => ({ id: "sub_x", status: "canceled" }) };
      if (redeFalha) throw new TypeError("fetch failed");
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
    },
    registrar: async (row) => {
      chamadas.registrar.push(row);
      if (registrarLanca) throw new Error("banco fora");
      return { id: UUID, status: row.status };
    },
    log: (nivel, evento, dados) => chamadas.log.push({ nivel, evento, dados }),
  };
  return { deps, chamadas };
}

// Todas as chaves do JSON, menos dentro de customer.phones (o Pagar.me exige "number" no telefone;
// o formato exato do telefone e conferido a parte com deepEqual).
function chaves(valor, acc = []) {
  if (valor && typeof valor === "object") {
    for (const [k, v] of Object.entries(valor)) { acc.push(k); if (k !== "phones") chaves(v, acc); }
  }
  return acc;
}

test("sandbox com sk_live_ -> 500 CHAVE_NAO_SANDBOX e zero fetch", async () => {
  const { deps, chamadas } = falsos({ env: { PAGARME_ASSINATURA_SECRET_KEY: "sk_live_x" } });
  const r = await processarCheckout(pedido(), deps);
  assert.equal(r.http, 500);
  assert.equal(r.body.error_code, "CHAVE_NAO_SANDBOX");
  assert.equal(chamadas.fetch.length, 0);
  assert.equal(chamadas.registrar.length, 0);
});

test("ambiente ausente vale sandbox: sk_live_ continua recusada", async () => {
  const { deps, chamadas } = falsos({ env: { PAGARME_ASSINATURA_AMBIENTE: undefined, PAGARME_ASSINATURA_SECRET_KEY: "sk_live_x" } });
  const r = await processarCheckout(pedido(), deps);
  assert.equal(r.body.error_code, "CHAVE_NAO_SANDBOX");
  assert.equal(chamadas.fetch.length, 0);
});

test("venda fechada -> 403 VENDA_FECHADA sem fetch", async () => {
  const { deps, chamadas } = falsos({ env: { AUDITOR_VENDA_ABERTA: "nao" } });
  const r = await processarCheckout(pedido(), deps);
  assert.equal(r.http, 403);
  assert.deepEqual(Object.keys(r.body).sort(), ["error_code", "mensagem", "ok"]);
  assert.equal(r.body.error_code, "VENDA_FECHADA");
  assert.equal(chamadas.fetch.length, 0);
});

test("sem secret -> 500 CONFIG_AUSENTE sem fetch", async () => {
  const { deps, chamadas } = falsos({ env: { PAGARME_ASSINATURA_SECRET_KEY: "" } });
  const r = await processarCheckout(pedido(), deps);
  assert.equal(r.http, 500);
  assert.equal(r.body.error_code, "CONFIG_AUSENTE");
  assert.equal(chamadas.fetch.length, 0);
});

test("corpo do /subscriptions: plano certo, card_token, nenhum campo de cartao", async () => {
  const { deps, chamadas } = falsos();
  await processarCheckout(pedido({ plano: "agencia" }), deps);
  assert.equal(chamadas.fetch.length, 1);
  const c = chamadas.fetch[0];
  assert.equal(c.url, "https://pagarme.simulado/core/v5/subscriptions");
  assert.equal(c.method, "POST");
  assert.equal(c.headers["Content-Type"], "application/json");
  assert.equal(c.headers.Authorization, `Basic ${btoa("sk_test_x:")}`);
  assert.equal(c.body.plan_id, "plan_agencia");
  assert.equal(c.body.card_token, "token_abc123");
  assert.equal(c.body.payment_method, "credit_card");
  assert.deepEqual(Object.keys(c.body).sort(), ["card_token", "customer", "metadata", "payment_method", "plan_id"]);
  const todas = chaves(c.body);
  for (const campo of CAMPOS_CARTAO) assert.ok(!todas.includes(campo), `campo de cartao no corpo: ${campo}`);
  assert.deepEqual(c.body.customer, {
    name: "Maria Teste",
    email: "maria@exemplo.com",
    document: "12345678909",
    type: "individual",
    phones: { mobile_phone: { country_code: "55", area_code: "11", number: "987654321" } },
  });
  assert.deepEqual(c.body.metadata, { origem: "auditor", plano: "agencia" });
});

test("CNPJ vira company e o WhatsApp vai em phones e no registro", async () => {
  const { deps, chamadas } = falsos();
  const r = await processarCheckout(pedido({ documento: "12.345.678/0001-95" }), deps);
  assert.equal(r.http, 200);
  assert.equal(chamadas.fetch[0].body.customer.type, "company");
  assert.deepEqual(chamadas.fetch[0].body.customer.phones.mobile_phone, { country_code: "55", area_code: "11", number: "987654321" });
  assert.equal(chamadas.registrar[0].whatsapp, "11987654321");
});

// Aceite unico e obrigatorio (Lucca, 16/10): Termos + relatorio no WhatsApp. Sem ele, nenhuma chamada ao Pagar.me.
for (const [nome, extra] of [
  ["sem WhatsApp", { telefone: undefined }],
  ["WhatsApp vazio", { telefone: "" }],
  ["aceite ausente", { termos_aceite: undefined }],
  ["aceite desmarcado", { termos_aceite: false }],
  ['aceite "true" em string', { termos_aceite: "true" }],
  ["texto do aceite ausente", { aceite_texto: undefined }],
  ["texto livre no lugar do aceite", { aceite_texto: "Quero receber o relatorio no WhatsApp" }],
  ["texto da antiga caixa opcional", {
    aceite_texto: "Quero receber o relatório do Auditor no WhatsApp da nó (+55 11 93928-9413), no telefone que informei acima. Opcional.",
  }],
  ["campo cvv no body", { cvv: "123" }],
  ["campo card no body", { card: { number: "4000000000000010" } }],
  ["card_token sem prefixo token_", { card_token: "card_123" }],
  ["documento com 12 digitos", { documento: "123456789012" }],
  ["e-mail invalido", { email: "maria@exemplo" }],
  ["plano desconhecido", { plano: "anual" }],
  ["nome curto", { nome: " M " }],
  ["telefone curto", { telefone: "1198765" }],
]) {
  test(`recusa ${nome} -> 400 DADOS_INVALIDOS sem fetch`, async () => {
    const { deps, chamadas } = falsos();
    const r = await processarCheckout(pedido(extra), deps);
    assert.equal(r.http, 400);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error_code, "DADOS_INVALIDOS");
    assert.ok(r.body.mensagem.length > 0);
    assert.equal(chamadas.fetch.length, 0);
  });
}

test("plano sem plan_id -> 409 PLANO_INDISPONIVEL sem fetch", async () => {
  const { deps, chamadas } = falsos({ env: { PAGARME_PLANO_SEMANAL_ID: "" } });
  const r = await processarCheckout(pedido(), deps);
  assert.equal(r.http, 409);
  assert.equal(r.body.error_code, "PLANO_INDISPONIVEL");
  assert.equal(chamadas.fetch.length, 0);
});

test("ok -> 200 pendente e o registrar recebe WhatsApp + texto fixo do aceite", async () => {
  const { deps, chamadas } = falsos();
  // Espacos e quebras do textContent do navegador sao normalizados; o que se grava e a constante do servidor.
  const r = await processarCheckout(
    pedido({ aceite_texto: `  ${TEXTO_ACEITE_ASSINATURA.replace("Sei que", "\n   Sei   que")} ` }), deps);
  assert.deepEqual(r, { http: 200, body: { ok: true, status: "pendente", assinatura_id: UUID } });
  assert.deepEqual(chamadas.registrar, [{
    plano: "semanal",
    nome: "Maria Teste",
    email: "maria@exemplo.com",
    whatsapp: "11987654321",
    customer_id: "cus_x",
    subscription_id: "sub_x",
    status: "pendente",
    aceite_texto: TEXTO_ACEITE_ASSINATURA,
  }]);
  assert.ok(TEXTO_ACEITE_ASSINATURA.includes("relatório do Auditor chega no WhatsApp que informei"));
  assert.ok(TEXTO_ACEITE_ASSINATURA.includes("Termos de Uso") && TEXTO_ACEITE_ASSINATURA.includes("Política de Privacidade"));
  assert.ok(!JSON.stringify(chamadas.log).includes("maria@exemplo.com"), "log com e-mail");
  assert.ok(!JSON.stringify(chamadas.log).includes("12345678909"), "log com documento");
});

test("Pagar.me responde status failed -> 402 PAGAMENTO_RECUSADO (registrado como recusada)", async () => {
  const { deps, chamadas } = falsos({ resposta: { status: 200, body: { id: "sub_x", status: "failed" } } });
  const r = await processarCheckout(pedido(), deps);
  assert.equal(r.http, 402);
  assert.equal(r.body.error_code, "PAGAMENTO_RECUSADO");
  assert.equal(chamadas.registrar[0].status, "recusada");
  assert.equal(chamadas.registrar[0].customer_id, null);
});

test("Pagar.me 500 -> 502 PAGARME_FALHOU, sem registrar e sem body no log", async () => {
  const { deps, chamadas } = falsos({ resposta: { status: 500, body: { message: "segredo do corpo maria@exemplo.com" } } });
  const r = await processarCheckout(pedido(), deps);
  assert.equal(r.http, 502);
  assert.equal(r.body.error_code, "PAGARME_FALHOU");
  assert.equal(chamadas.registrar.length, 0);
  assert.ok(!JSON.stringify(chamadas.log).includes("segredo do corpo"));
  assert.ok(chamadas.log.some((l) => l.dados?.http_status === 500));
});

test("erro de rede e id sem sub_ -> 502 PAGARME_FALHOU", async () => {
  const rede = falsos({ redeFalha: true });
  assert.equal((await processarCheckout(pedido(), rede.deps)).body.error_code, "PAGARME_FALHOU");
  const semId = falsos({ resposta: { status: 200, body: { id: "ch_123", status: "active" } } });
  assert.equal((await processarCheckout(pedido(), semId.deps)).body.error_code, "PAGARME_FALHOU");
  assert.equal(semId.chamadas.registrar.length, 0);
});

test("registrar lanca -> DELETE /subscriptions/sub_x e 500 REGISTRO_FALHOU", async () => {
  const { deps, chamadas } = falsos({ registrarLanca: true });
  const r = await processarCheckout(pedido(), deps);
  assert.equal(r.http, 500);
  assert.equal(r.body.error_code, "REGISTRO_FALHOU");
  assert.equal(chamadas.fetch.length, 2);
  assert.equal(chamadas.fetch[1].method, "DELETE");
  assert.equal(chamadas.fetch[1].url, "https://pagarme.simulado/core/v5/subscriptions/sub_x");
  assert.equal(chamadas.fetch[1].headers.Authorization, `Basic ${btoa("sk_test_x:")}`);
});

test("respostaGet nao contem a secret e lista os planos", () => {
  const get = respostaGet(lerConfig({ ...ENV, PAGARME_PLANO_AGENCIA_ID: "" }));
  assert.ok(!JSON.stringify(get).includes("sk_test_x"));
  assert.deepEqual(get, {
    ambiente: "sandbox",
    venda_aberta: true,
    medicao_liberada: false,
    public_key: "pk_test_x",
    planos: [
      { codigo: "mensal", disponivel: true },
      { codigo: "semanal", disponivel: true },
      { codigo: "agencia", disponivel: false },
    ],
  });
  assert.equal(lerConfig({}).apiUrl, "https://api.pagar.me/core/v5");
  assert.equal(respostaGet(lerConfig({})).public_key, "");
});

test("compensacao cancela as faturas pendentes e a mensagem nao promete que nada foi cobrado", async () => {
  const { deps, chamadas } = falsos({ registrarLanca: true });
  const r = await processarCheckout(pedido(), deps);
  assert.deepEqual(chamadas.fetch[1].body, { cancel_pending_invoices: true });
  // cancelar nao estorna a primeira cobranca ja aprovada: a pessoa precisa saber onde reclamar
  assert.doesNotMatch(r.body.mensagem, /nada (fica|foi) cobrado/i);
  assert.match(r.body.mensagem, /WhatsApp/);
});

test("reconciliacao trouxe cancelamento -> 409 ASSINATURA_CANCELADA, nunca ok", async () => {
  const { deps } = falsos();
  deps.registrar = async () => ({ id: UUID, status: "cancelada" });
  const r = await processarCheckout(pedido(), deps);
  assert.equal(r.http, 409);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.error_code, "ASSINATURA_CANCELADA");
});

test("reconciliacao trouxe pagamento -> 200 ok paga", async () => {
  const { deps } = falsos();
  deps.registrar = async () => ({ id: UUID, status: "paga" });
  const r = await processarCheckout(pedido(), deps);
  assert.deepEqual(r, { http: 200, body: { ok: true, status: "paga", assinatura_id: UUID } });
});
