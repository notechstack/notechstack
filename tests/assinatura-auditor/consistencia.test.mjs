// Os 3 precos aprovados por Lucca (fontes/proposta-planos-T1.md: R$ 47, R$ 97, R$ 197 por mes) sao os mesmos
// em todos os lugares que os repetem: pagina, checkout, medicao, funcao e script de planos do Pagar.me.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { PLANOS as PLANOS_SCRIPT } from "../../scripts/pagarme-assinatura/planos.mjs";
import { PLANOS as PLANOS_FUNCAO } from "../../supabase/functions/assinatura-auditor/core.ts";

const APROVADO = { mensal: 47, semanal: 97, agencia: 197 };
const raiz = (p) => new URL(`../../${p}`, import.meta.url);

test("script de planos do Pagar.me: centavos = preco aprovado x 100, cobranca mensal so no cartao", () => {
  assert.deepEqual(PLANOS_SCRIPT.map((p) => p.codigo).sort(), Object.keys(APROVADO).sort());
  for (const p of PLANOS_SCRIPT) assert.equal(p.centavos, APROVADO[p.codigo] * 100, p.codigo);
});

test("funcao de checkout: centavos = preco aprovado x 100", () => {
  assert.deepEqual(Object.keys(PLANOS_FUNCAO).sort(), Object.keys(APROVADO).sort());
  for (const [codigo, p] of Object.entries(PLANOS_FUNCAO)) assert.equal(p.centavos, APROVADO[codigo] * 100, codigo);
});

test("checkout do navegador e medicao usam o mesmo valor em reais", async () => {
  const dataLayer = [];
  const window = {
    dataLayer,
    crypto: webcrypto,
  };
  const ctx = vm.createContext({
    window,
    crypto: webcrypto,
    localStorage: { getItem: () => "granted" },
    URLSearchParams,
    location: { hostname: "www.notechstack.com.br", search: "" },
  });
  vm.runInContext(await readFile(raiz("agentes/auditor/assinatura-medicao.js"), "utf8"), ctx);
  vm.runInContext(await readFile(raiz("agentes/auditor/assinatura.js"), "utf8"), ctx);
  for (const [codigo, valor] of Object.entries(APROVADO)) {
    assert.equal(window.noAssinatura.PLANOS[codigo].valor, valor, `checkout ${codigo}`);
    window.noAssinaturaMedicao.iniciada(codigo);
    assert.equal(dataLayer.at(-1).valor, valor, `medicao ${codigo}`);
  }
});

test("pagina: cada card mostra o preco aprovado", async () => {
  const html = await readFile(raiz("agentes/auditor/index.html"), "utf8");
  const secao = html.slice(html.indexOf('id="planos"'), html.indexOf("</section>", html.indexOf('id="planos"')));
  for (const [codigo, valor] of Object.entries(APROVADO)) {
    const ini = secao.indexOf(`data-plano="${codigo}"`);
    assert.ok(ini >= 0, `card ${codigo}`);
    assert.match(secao, new RegExp(`R\\$\\s*${valor}\\b`), `preco ${codigo}`);
  }
});
