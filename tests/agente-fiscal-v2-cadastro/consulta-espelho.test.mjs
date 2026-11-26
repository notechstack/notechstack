// Consulta de CNPJ com espelho da BrasilAPI, sem banco. Em 23/11/2026 a BrasilAPI falhou por ~30 min e nenhum
// escritório conseguiu adicionar empresa: agora a minhareceita.org (mesmos campos) cobre a falha.
import test from "node:test";
import assert from "node:assert/strict";
import { CNPJ_API_ESPELHO, consultarCnpj } from "../../supabase/functions/_shared/fiscal/cnpj.ts";
import { respostaBrasilApi } from "./banco.mjs";

const CNPJ = "48186482000142";
const PRINCIPAL = "https://cnpj.simulado";

/** Responde por fonte: "fora" derruba a conexão, número é o status, objeto é o corpo 200. */
function fontes({ principal, espelho }) {
  const urls = [];
  const fetch = async (url) => {
    urls.push(url);
    const r = url.startsWith(PRINCIPAL) ? principal : espelho;
    if (r === "fora") throw new TypeError("fetch failed");
    if (typeof r === "number") return new Response("{}", { status: r });
    return new Response(JSON.stringify(r), { status: 200 });
  };
  return { fetch, urls };
}

test("principal responde: o espelho nem é chamado", async () => {
  const f = fontes({ principal: respostaBrasilApi(CNPJ), espelho: 500 });
  const c = await consultarCnpj(CNPJ, { apiUrl: PRINCIPAL, fetch: f.fetch });
  assert.equal(c.ok, true);
  assert.deepEqual(f.urls, [`${PRINCIPAL}/api/cnpj/v1/${CNPJ}`]);
});

for (const falha of ["fora", 502, 429, 403]) {
  test(`principal falha (${falha}): o espelho confirma o CNPJ`, async () => {
    const f = fontes({ principal: falha, espelho: respostaBrasilApi(CNPJ, { regime: "mei" }) });
    const c = await consultarCnpj(CNPJ, { apiUrl: PRINCIPAL, fetch: f.fetch });
    assert.equal(c.ok, true);
    assert.equal(c.dados.regime, "mei");
    assert.deepEqual(f.urls, [`${PRINCIPAL}/api/cnpj/v1/${CNPJ}`, `${CNPJ_API_ESPELHO}/${CNPJ}`]);
  });
}

test("principal com corpo incompleto: o espelho responde", async () => {
  const f = fontes({ principal: { razao_social: "X" }, espelho: respostaBrasilApi(CNPJ) });
  const c = await consultarCnpj(CNPJ, { apiUrl: PRINCIPAL, fetch: f.fetch });
  assert.equal(c.ok, true);
});

test("404 da principal vai à reserva CNPJ.ws, não ao espelho", async () => {
  const urls = [];
  const fetch = async (url) => {
    urls.push(url);
    return url.startsWith(PRINCIPAL) ? new Response("{}", { status: 404 }) : new Response("{}", { status: 500 });
  };
  const c = await consultarCnpj(CNPJ, { apiUrl: PRINCIPAL, reservaUrl: "https://reserva.simulada", fetch });
  assert.deepEqual(c, { ok: false, motivo: "nao_encontrado" });
  assert.deepEqual(urls, [`${PRINCIPAL}/api/cnpj/v1/${CNPJ}`, `https://reserva.simulada/cnpj/${CNPJ}`]);
});

test("as duas falham: indisponível, com o que cada uma respondeu para a log", async () => {
  const f = fontes({ principal: 503, espelho: "fora" });
  const c = await consultarCnpj(CNPJ, { apiUrl: PRINCIPAL, fetch: f.fetch });
  assert.equal(c.ok, false);
  assert.equal(c.motivo, "indisponivel");
  assert.deepEqual(c.tentativas.map(({ fonte, status, erro }) => ({ fonte, status, erro })), [
    { fonte: "principal", status: 503, erro: undefined },
    { fonte: "espelho", status: undefined, erro: "rede" },
  ]);
  assert.ok(c.tentativas.every((t) => typeof t.ms === "number"));
  assert.ok(!JSON.stringify(c.tentativas).includes(CNPJ), "a log não leva o CNPJ");
});

test("espelhoUrl próprio e espelho desligado", async () => {
  const outra = fontes({ principal: 500, espelho: respostaBrasilApi(CNPJ) });
  assert.equal((await consultarCnpj(CNPJ, { apiUrl: PRINCIPAL, espelhoUrl: "https://espelho.simulada/", fetch: outra.fetch })).ok, true);
  assert.equal(outra.urls[1], `https://espelho.simulada/${CNPJ}`);

  const sem = fontes({ principal: 500, espelho: respostaBrasilApi(CNPJ) });
  const c = await consultarCnpj(CNPJ, { apiUrl: PRINCIPAL, espelhoUrl: null, fetch: sem.fetch });
  assert.equal(c.motivo, "indisponivel");
  assert.equal(sem.urls.length, 1);
});

test("principal que não responde a tempo: o espelho assume", { timeout: 20000 }, async () => {
  const fetch = (url, init) => url.startsWith(PRINCIPAL)
    ? new Promise((_, falha) => init.signal.addEventListener("abort", () => falha(new DOMException("abortado", "AbortError"))))
    : Promise.resolve(new Response(JSON.stringify(respostaBrasilApi(CNPJ)), { status: 200 }));
  const c = await consultarCnpj(CNPJ, { apiUrl: PRINCIPAL, fetch });
  assert.equal(c.ok, true);
});
