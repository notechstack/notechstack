// meta-capi (03/11/2026): AddToCart e Lead do nó.fiscal entram com travas próprias; PageView e ViewContent seguem
// como antes. A função roda no Deno: aqui Deno.serve, Deno.env e fetch são dublês, e o handler é chamado direto.
import test from "node:test";
import assert from "node:assert/strict";

let handler;
const enviados = [];
globalThis.Deno = {
  serve: (fn) => { handler = fn; },
  env: { get: (k) => (k === "META_ACCESS_TOKEN" ? "tok" : undefined) },
};
globalThis.fetch = async (url, init) => {
  enviados.push({ url, body: JSON.parse(init.body) });
  return { ok: true, status: 200, json: async () => ({ events_received: 1 }) };
};
await import("../../supabase/functions/meta-capi/index.ts");

const SITE = "https://www.notechstack.com.br";
async function chamar(body, origin = SITE) {
  enviados.length = 0;
  const headers = { "Content-Type": "application/json", "user-agent": "Mozilla/5.0 teste", "x-forwarded-for": "200.1.2.3, 10.0.0.1" };
  if (origin) headers.origin = origin;
  const res = await handler(new Request("https://fn.test/meta-capi", { method: "POST", headers, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json(), evento: enviados[0]?.body.data[0] };
}

const ADD_TO_CART = {
  event_name: "AddToCart",
  event_id: "nofiscal-6f1c2a9e-1111-4222-8333-444455556666",
  event_source_url: `${SITE}/agentes/fiscal/?utm_source=meta`,
  fbp: "fb.1.1761140000000.1234567890",
  custom_data: {
    value: 129, currency: "BRL", content_name: "nó.fiscal Pro", content_ids: ["nofiscal-pro-mensal"], content_type: "product",
  },
};

test("ViewContent continua igual: sem Origin, só value e currency no custom_data", async () => {
  const r = await chamar({
    event_name: "ViewContent", event_id: "agentes-vc-1", event_source_url: `${SITE}/agentes/`,
    content_category: "saude", custom_data: { content_name: "Clínica", content_ids: ["x"] },
  }, null);
  assert.equal(r.status, 200);
  assert.deepEqual(r.evento.custom_data, { value: 0, currency: "BRL" });
  assert.equal(r.evento.event_source_url, `${SITE}/agentes/`);
  assert.equal(r.evento.action_source, "website");
});

test("AddToCart do nó.fiscal: mesmo event_id, custom_data do plano, página sem query", async () => {
  const r = await chamar(ADD_TO_CART);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.evento.event_name, "AddToCart");
  assert.equal(r.evento.event_id, ADD_TO_CART.event_id);
  assert.equal(r.evento.event_source_url, `${SITE}/agentes/fiscal/`);
  assert.deepEqual(r.evento.custom_data, ADD_TO_CART.custom_data);
  assert.equal(r.evento.user_data.fbp, ADD_TO_CART.fbp);
  assert.equal(r.evento.user_data.client_ip_address, "200.1.2.3");
  assert.equal(enviados[0].url, "https://graph.facebook.com/v21.0/1753619075655271/events?access_token=tok");
});

test("Lead do nó.fiscal (Escritório/Agência) com value no topo do corpo, como o ViewContent de sempre", async () => {
  const r = await chamar({
    event_name: "Lead", event_id: "nofiscal-lead-6f1c2a9e-1111-4222-8333-444455556666",
    event_source_url: `${SITE}/agentes/fiscal/`, value: 0, currency: "BRL",
    custom_data: { content_name: "nó.fiscal Escritório", content_category: "nofiscal" },
  }, "https://notechstack.com.br");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.evento.custom_data, { value: 0, currency: "BRL", content_name: "nó.fiscal Escritório", content_category: "nofiscal" });
});

test("custom_data fora do nó.fiscal é descartado (sem caminho para categoria de saúde)", async () => {
  const r = await chamar({
    ...ADD_TO_CART,
    custom_data: {
      value: 9e9, currency: "reais", content_name: "Consulta psicológica", content_ids: ["saude-1"],
      content_type: "service", content_category: "saude", contents: [{ id: "x" }],
    },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.evento.custom_data, { value: 0, currency: "BRL" });
});

test("AddToCart e Lead: Origin fora do site, event_id fora do formato ou sem página -> recusa sem chamar a Meta", async () => {
  for (const origin of [null, "https://evil.test", "http://www.notechstack.com.br", "https://www.notechstack.com.br:8443", "null"]) {
    const r = await chamar(ADD_TO_CART, origin);
    assert.equal(r.status, 403, String(origin));
    assert.equal(r.body.error, "origem_nao_permitida");
  }
  for (const event_id of [undefined, "", "abc", "nofiscal-<x>", `nofiscal-${"a".repeat(120)}`]) {
    const r = await chamar({ ...ADD_TO_CART, event_id });
    assert.equal(r.status, 400, String(event_id));
    assert.equal(r.body.error, "event_id_invalido");
  }
  for (const event_source_url of [undefined, "https://evil.test/agentes/fiscal/", "javascript:alert(1)"]) {
    const r = await chamar({ ...ADD_TO_CART, event_source_url });
    assert.equal(r.status, 400, String(event_source_url));
    assert.equal(r.body.error, "event_source_url_invalido");
  }
  assert.equal(enviados.length, 0);
});

test("lista fechada continua: Purchase e outros nomes voltam 400; corpo vazio ou não-objeto -> event_name_required", async () => {
  for (const nome of ["Purchase", "StartTrial", "Contact"]) {
    const r = await chamar({ event_name: nome, event_id: "nofiscal-123456" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "evento_nao_permitido");
  }
  assert.equal((await chamar({})).body.error, "event_name_required");
  assert.equal((await chamar(null)).body.error, "event_name_required");
  assert.equal((await chamar([1])).body.error, "event_name_required");
});
