// Os 3 precos aprovados por Lucca sao LIDOS de fontes/proposta-planos-T1.md (nao copiados a mao) e sao os mesmos
// em todos os lugares que os repetem: tela final da retrospectiva, checkout, medicao, funcao e script de planos do Pagar.me.
// F-03 (Oscar): o preco e conferido DENTRO de cada cartao de plano; trocar os precos entre cartoes falha.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { PLANOS as PLANOS_SCRIPT } from "../../scripts/pagarme-assinatura/planos.mjs";
import { PLANOS as PLANOS_FUNCAO, TEXTO_ACEITE_ASSINATURA, validarPedido, corpoAssinatura } from "../../supabase/functions/assinatura-auditor/core.ts";

const raiz = (p) => new URL(`../../${p}`, import.meta.url);        // repo
const tarefa = (p) => new URL(`../../../${p}`, import.meta.url);   // raiz da pasta da TASK (fontes/, retrospectiva/)

// ── Preços da T1, lidos do arquivo aprovado ──
const CODIGOS = { Mensal: "mensal", Semanal: "semanal", "Agência": "agencia" };
const t1 = await readFile(tarefa("fontes/proposta-planos-T1.md"), "utf8");
const APROVADO = {};
for (const m of t1.matchAll(/^### Plano \d · (Mensal|Semanal|Agência)[^\n]*\n([\s\S]*?)(?=^### |^## )/gm)) {
  const preco = m[2].match(/\*\*Preço:\*\*[^\n]*?R\$ (\d+)\/mês/);
  assert.ok(preco, `preço do plano ${m[1]} na T1`);
  APROVADO[CODIGOS[m[1]]] = Number(preco[1]);
}

test("T1 lida do arquivo: 3 planos, cada um com preço inteiro em reais", () => {
  assert.deepEqual(Object.keys(APROVADO).sort(), ["agencia", "mensal", "semanal"]);
  for (const [codigo, v] of Object.entries(APROVADO)) assert.ok(Number.isInteger(v) && v > 0, codigo);
  assert.ok(APROVADO.mensal < APROVADO.semanal && APROVADO.semanal < APROVADO.agencia, "escada Mensal < Semanal < Agência");
});

test("script de planos do Pagar.me: centavos = preco aprovado x 100", () => {
  assert.deepEqual(PLANOS_SCRIPT.map((p) => p.codigo).sort(), Object.keys(APROVADO).sort());
  for (const p of PLANOS_SCRIPT) assert.equal(p.centavos, APROVADO[p.codigo] * 100, p.codigo);
});

test("funcao de checkout: centavos = preco aprovado x 100", () => {
  assert.deepEqual(Object.keys(PLANOS_FUNCAO).sort(), Object.keys(APROVADO).sort());
  for (const [codigo, p] of Object.entries(PLANOS_FUNCAO)) assert.equal(p.centavos, APROVADO[codigo] * 100, codigo);
});

test("checkout do navegador e medicao usam o mesmo valor em reais", async () => {
  const dataLayer = [];
  const window = { dataLayer, crypto: webcrypto };
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

test("tela final da retrospectiva: cada cartao mostra so o seu preco aprovado (F-03: conferido dentro do cartao)", async () => {
  const html = await readFile(tarefa("retrospectiva/index.html"), "utf8");
  const telas = [...html.matchAll(/<section\b[^>]*\bdata-estado="([^"]*)"[^>]*>[\s\S]*?<\/section>/g)];
  const ultima = telas.at(-1);
  assert.equal(ultima[1], "planos", "a tela de planos e a ultima");
  const cartoes = ultima[0].split(/<div class="cartao au-plano(?=[ "])/).slice(1); // só os cartões de plano, não o lead/nota
  assert.equal(cartoes.length, Object.keys(APROVADO).length, "um cartao por plano");
  const vistos = [];
  for (const c of cartoes) {
    const codigo = c.match(/data-plano="(\w+)"/)[1];
    vistos.push(codigo);
    const precos = [...c.matchAll(/R\$\s*(\d+)/g)].map((m) => Number(m[1]));
    assert.deepEqual(precos, [APROVADO[codigo]], `cartao ${codigo} mostra so R$ ${APROVADO[codigo]}`);
  }
  assert.deepEqual(vistos.sort(), Object.keys(APROVADO).sort());
});

// Rodada 8: o corpo que o checkout de duas etapas monta (nome + sobrenome juntos, endereco de cobranca) passa na
// validacao da funcao e chega ao Pagar.me com o endereco no cartao e no cliente.
test("checkout de duas etapas: o corpo do navegador passa na funcao e leva o endereco ao Pagar.me", async () => {
  const ctx = vm.createContext({ window: {} });
  vm.runInContext(await readFile(raiz("agentes/auditor/assinatura.js"), "utf8"), ctx);
  const d = {
    plano: "agencia", nome: " Ana ", sobrenome: "Lima ", email: "ana@exemplo.com.br", telefone: "(11) 99999-0000",
    termos_aceite: true, documento: "123.456.789-09",
    endereco: { cep: "01001-000", rua: "Praça da Sé", numero: "100", complemento: "sala 2", bairro: "Sé", cidade: "São Paulo", uf: "sp" },
  };
  const corpo = JSON.parse(JSON.stringify(ctx.window.noAssinatura.montarPedido(d, "token_abc123", TEXTO_ACEITE_ASSINATURA)));
  const r = validarPedido(corpo);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.pedido.nome, "Ana Lima");
  const pg = corpoAssinatura(r.pedido, "plan_x");
  assert.equal(pg.card.billing_address.zip_code, "01001000");
  assert.equal(pg.card.billing_address.state, "SP");
  assert.equal(pg.customer.address.line_2, "sala 2");
  assert.ok(!("sobrenome" in corpo), "sobrenome vai junto do nome");
});

test("LP do auditor nao repete preco nenhum (planos so no fim da retrospectiva)", async () => {
  const lp = await readFile(raiz("agentes/auditor/index.html"), "utf8");
  for (const valor of Object.values(APROVADO)) assert.doesNotMatch(lp, new RegExp(`R\\$\\s*${valor}\\b`), `R$ ${valor} fora da LP`);
});
