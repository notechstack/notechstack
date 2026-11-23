// Plano "nó.fiscal Guias" achado ou criado pela própria função (sem PAGARME_PLANO_FISCAL_GUIAS_ID), para ninguém colar a
// sk_ num script (Lucca, 23/11/2026). Sem banco: dependências em memória e o Pagar.me num dublê.
import test from "node:test";
import assert from "node:assert/strict";
import { PLANO_GUIAS, obterPlanoGuias, processarGuias } from "../../supabase/functions/assinatura-fiscal-guias/core.ts";

const API = "https://pagarme.simulado/core/v5";
const TENANT = "eb74ab2c-41ed-489b-905a-fb5440c00246";
const FIM_DO_TESTE = "2026-12-16T18:42:00.000Z";
const resp = (status, corpo) => new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });
const planoGuias = (id, extra = {}) => ({
  id, name: PLANO_GUIAS.nome, status: "active", interval: "month",
  items: [{ pricing_scheme: { price: PLANO_GUIAS.centavos } }], ...extra,
});

function pagarme({ planos = [], falharPlano = false } = {}) {
  const chamadas = [];
  return {
    chamadas,
    fetch: async (url, init = {}) => {
      const u = new URL(url);
      const metodo = init.method || "GET";
      const caminho = u.pathname.replace("/core/v5", "");
      const corpo = init.body ? JSON.parse(init.body) : null;
      chamadas.push({ metodo, caminho, corpo, headers: init.headers || {} });
      if (caminho === "/plans" && metodo === "GET") return falharPlano ? resp(500, {}) : resp(200, { data: planos });
      if (caminho === "/plans" && metodo === "POST") return falharPlano ? resp(500, {}) : resp(200, { id: "plan_criado", ...corpo });
      if (caminho.startsWith("/subscriptions/") && metodo === "GET") {
        return resp(200, { id: "sub_principal", status: "future", start_at: FIM_DO_TESTE, customer: { id: "cus_x" }, card: { id: "card_x", status: "active" } });
      }
      if (caminho === "/subscriptions" && metodo === "POST") return resp(200, { id: "sub_guias", status: "future", ...corpo });
      return resp(404, {});
    },
  };
}

const deps = (pg, env = {}) => ({
  env: { PAGARME_ASSINATURA_SECRET_KEY: "sk_test_x", PAGARME_ASSINATURA_API_URL: API, PAGARME_ASSINATURA_AMBIENTE: "sandbox", ...env },
  fetch: pg.fetch,
  agora: () => new Date("2026-11-23T12:00:00Z"),
  contexto: async () => ({ ok: true, principal: { pagarme_subscription_id: "sub_principal", status: "pendente", origem: "pagarme" }, guias: null }),
  reservar: async () => ({ ok: true, reservado: true, geracao: 0 }),
  soltar: async () => {},
  registrar: async () => ({ ok: true }),
  ligarModulo: async () => ({}),
  desligar: async () => ({ ok: true }),
  cancelamentoPedido: async () => {},
  validarCupom: async () => ({ ok: true, codigo: "FUNDADORGUIAS", tipo: "valor", valor: 5000, ciclos: 12 }),
});

const H = { "Content-Type": "application/json", Authorization: "Basic x" };

test("acha o plano que já existe e não cria outro", async () => {
  const pg = pagarme({ planos: [planoGuias("plan_outro_preco", { items: [{ pricing_scheme: { price: 100 } }] }), planoGuias("plan_ok")] });
  assert.equal(await obterPlanoGuias(pg, API, H), "plan_ok");
  assert.equal(pg.chamadas.filter((c) => c.metodo === "POST").length, 0);
});

test("sem plano igual, cria uma vez com Idempotency-Key fixa e o corpo do plano", async () => {
  const pg = pagarme({ planos: [planoGuias("plan_inativo", { status: "inactive" })] });
  assert.equal(await obterPlanoGuias(pg, API, H), "plan_criado");
  const post = pg.chamadas.find((c) => c.metodo === "POST");
  assert.equal(post.headers["Idempotency-Key"], "nofiscal-plano-guias-v1");
  assert.equal(post.corpo.name, PLANO_GUIAS.nome);
  assert.equal(post.corpo.statement_descriptor, "NOFISCALGUIAS");
  assert.equal(post.corpo.items[0].pricing_scheme.price, 19700);
});

test("Pagar.me fora: devolve null, sem lançar", async () => {
  assert.equal(await obterPlanoGuias(pagarme({ falharPlano: true }), API, H), null);
});

test("ligar sem PAGARME_PLANO_FISCAL_GUIAS_ID usa o plano achado e cria a Guias em 16/12 com R$ 147", async () => {
  const pg = pagarme({ planos: [planoGuias("plan_ok")] });
  const r = await processarGuias({ metodo: "POST", autorizado: true, body: { acao: "ligar", tenant_id: TENANT, limite_mes: 500, cupom: "FUNDADORGUIAS" } }, deps(pg));
  assert.equal(r.http, 201);
  assert.equal(r.body.inicio, FIM_DO_TESTE);
  assert.equal(r.body.valor_com_desconto_centavos, 14700);
  const sub = pg.chamadas.find((c) => c.metodo === "POST" && c.caminho === "/subscriptions");
  assert.equal(sub.corpo.plan_id, "plan_ok");
});

test("com a variável gravada, não consulta /plans", async () => {
  const pg = pagarme();
  const r = await processarGuias({ metodo: "POST", autorizado: true, body: { acao: "ligar", tenant_id: TENANT } }, deps(pg, { PAGARME_PLANO_FISCAL_GUIAS_ID: "plan_env" }));
  assert.equal(r.http, 201);
  assert.equal(pg.chamadas.some((c) => c.caminho === "/plans"), false);
  assert.equal(pg.chamadas.find((c) => c.caminho === "/subscriptions" && c.metodo === "POST").corpo.plan_id, "plan_env");
});

test("sem achar nem criar o plano, recusa antes de reservar", async () => {
  let reservou = false;
  const d = { ...deps(pagarme({ falharPlano: true })), reservar: async () => { reservou = true; return { ok: true, reservado: true }; } };
  const r = await processarGuias({ metodo: "POST", autorizado: true, body: { acao: "ligar", tenant_id: TENANT } }, d);
  assert.equal(r.http, 502);
  assert.match(JSON.stringify(r.body), /PAGARME_PLANO_FALHOU/);
  assert.equal(reservou, false);
});
