// Medição da compra do nó.fiscal (Lucca, 22/10/2026): o checkout devolve o evento que o navegador repete e, com
// consentimento, manda o mesmo evento (mesmo event_id) para a Meta CAPI. Sem banco: dependências em dublê.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { TEXTO_ACEITE_FISCAL, processarCheckout } from "../../supabase/functions/assinatura-fiscal/core.ts";
import { enviarParaMeta, eventoDaCompra, lerMedicao } from "../../supabase/functions/assinatura-fiscal/medicao.ts";

const ENV = {
  PAGARME_ASSINATURA_SECRET_KEY: "sk_test_x",
  PAGARME_ASSINATURA_API_URL: "https://pagarme.simulado/core/v5",
  PAGARME_PLANO_FISCAL_INICIAL_ID: "plan_i",
  PAGARME_PLANO_FISCAL_PRO_ID: "plan_p",
  PAGARME_PLANO_FISCAL_INICIAL_SEM_TESTE_ID: "plan_is",
  PAGARME_PLANO_FISCAL_PRO_SEM_TESTE_ID: "plan_ps",
  FISCAL_VENDA_ABERTA: "sim",
  FISCAL_TRIAL_SALT: "sal",
};
const CONTEXTO = {
  tenant_id: "00000000-0000-4000-8000-000000000001",
  cnpj: "11444777000161",
  razao_social: "Empresa Teste",
  email: " Dono@Example.test ",
  phone_e164: "+5511987654321",
  trial_ends_at: null,
  assinatura: null,
};
const PEDIDO = {
  plano: "pro",
  card_token: "token_x",
  endereco: { cep: "01001000", rua: "Praça da Sé", numero: "1", bairro: "Sé", cidade: "São Paulo", uf: "SP" },
  termos_aceite: true,
  aceite_texto: TEXTO_ACEITE_FISCAL,
};
const MEDICAO = {
  consent: "granted",
  fbp: "fb.1.1761140000000.1234567890",
  fbc: "fb.1.1761140000000.IwAR0abcDEF_ghi-123",
  page_url: "https://www.notechstack.com.br/agentes/fiscal/comecar/?plano=pro&utm_source=meta",
};
const sha = (v) => createHash("sha256").update(v).digest("hex");

function dubles({ comTeste = false, meta = true } = {}) {
  const enviados = [];
  const deps = {
    env: ENV,
    sessao: async () => "user-1",
    contexto: async () => CONTEXTO,
    reivindicarTeste: async () => comTeste,
    registrar: async (l) => ({ id: "assin-1", status: l.status }),
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ id: "sub_1", status: "active", customer: { id: "cus_1" } }) }),
    validarCupom: async () => ({ ok: true, codigo: "METADE3", tipo: "percentual", valor: 50, cortesia: false, ciclos: 3, id: "c1" }),
    usarCupom: async () => ({ ok: true }),
    agora: () => new Date("2026-10-22T15:00:00Z"),
    cliente: { ip: "200.10.20.30", ua: "Mozilla/5.0 teste" },
    log: () => {},
    ...(meta ? { enviarMeta: async (corpo) => { enviados.push(corpo); return "ok_1"; } } : {}),
  };
  return { deps, enviados };
}

test("compra paga: a resposta traz o evento e a CAPI recebe o mesmo event_id, valor e hashes", async () => {
  const { deps, enviados } = dubles();
  const r = await processarCheckout({ ...PEDIDO, medicao: MEDICAO }, deps);
  assert.equal(r.http, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.medicao, {
    evento: "Purchase", event_id: "nofiscal-purchase-assin-1", transaction_id: "assin-1", valor: 129, moeda: "BRL",
  });
  assert.equal(enviados.length, 1);
  const [ev] = enviados[0].data;
  assert.equal(ev.event_name, "Purchase");
  assert.equal(ev.event_id, r.body.medicao.event_id, "dedup com o fbq do navegador");
  assert.equal(ev.action_source, "website");
  assert.equal(ev.event_time, Math.floor(Date.parse("2026-10-22T15:00:00Z") / 1000));
  assert.equal(ev.event_source_url, "https://www.notechstack.com.br/agentes/fiscal/comecar/", "sem query string");
  assert.deepEqual(ev.custom_data, { value: 129, currency: "BRL", order_id: "assin-1" });
  assert.deepEqual(ev.user_data, {
    em: [sha("dono@example.test")],
    ph: [sha("5511987654321")],
    external_id: [sha(CONTEXTO.tenant_id)],
    fbp: MEDICAO.fbp,
    fbc: MEDICAO.fbc,
    client_ip_address: "200.10.20.30",
    client_user_agent: "Mozilla/5.0 teste",
  });
});

test("cupom de desconto: o valor medido é o cobrado; teste grátis vira StartTrial", async () => {
  const { deps, enviados } = dubles();
  const r = await processarCheckout({ ...PEDIDO, cupom: "METADE3", medicao: MEDICAO }, deps);
  assert.equal(r.body.medicao.valor, 64.5);
  assert.equal(enviados[0].data[0].custom_data.value, 64.5);

  const t = dubles({ comTeste: true });
  const rt = await processarCheckout({ ...PEDIDO, medicao: MEDICAO }, t.deps);
  assert.equal(rt.body.medicao.evento, "StartTrial");
  assert.equal(rt.body.medicao.event_id, "nofiscal-trial-assin-1");
  assert.equal(t.enviados[0].data[0].event_name, "StartTrial");
});

test("sem consentimento, ou sem o segredo da Meta, nada sai para a Meta; a resposta continua com o evento", async () => {
  for (const medicao of [undefined, { ...MEDICAO, consent: "denied" }, "granted", { consent: "sim" }]) {
    const { deps, enviados } = dubles();
    const r = await processarCheckout({ ...PEDIDO, medicao }, deps);
    assert.equal(r.http, 200);
    assert.equal(enviados.length, 0, JSON.stringify(medicao));
    assert.equal(r.body.medicao.evento, "Purchase");
  }
  const { deps } = dubles({ meta: false });
  assert.equal((await processarCheckout({ ...PEDIDO, medicao: MEDICAO }, deps)).http, 200);
});

test("falha da Meta não derruba a assinatura", async () => {
  const { deps } = dubles();
  deps.enviarMeta = async () => { throw new Error("fora"); };
  const r = await processarCheckout({ ...PEDIDO, medicao: MEDICAO }, deps);
  assert.equal(r.http, 200);
  assert.equal(await enviarParaMeta(async () => { throw new TypeError("rede"); }, "t", {}), "erro_rede");
  assert.equal(await enviarParaMeta(async () => ({ ok: false, status: 400, json: async () => ({}) }), "t", {}), "erro_400");
  const chamadas = [];
  const ok = await enviarParaMeta(async (url, init) => { chamadas.push({ url, init }); return { ok: true, status: 200, json: async () => ({ events_received: 1 }) }; }, "tok", { data: [] });
  assert.equal(ok, "ok_1");
  assert.equal(chamadas[0].url, "https://graph.facebook.com/v21.0/1753619075655271/events?access_token=tok");
});

test("lerMedicao descarta fbp/fbc fora do formato e página fora do domínio", () => {
  assert.deepEqual(lerMedicao({ consent: "granted", fbp: "x", fbc: "<script>", page_url: "https://evil.test/a" }), {
    consent: "granted", fbp: null, fbc: null, page_url: null,
  });
  assert.deepEqual(lerMedicao({ consent: "denied", fbp: MEDICAO.fbp }), { consent: "denied", fbp: null, fbc: null, page_url: null });
  assert.deepEqual(eventoDaCompra("a", false, 4900), { evento: "Purchase", event_id: "nofiscal-purchase-a", transaction_id: "a", valor: 49, moeda: "BRL" });
});
