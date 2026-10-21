// Revisão do #66 (A3): a Política diz exatamente o que vai na cópia pelo WhatsApp (o texto do e-mail, com totais),
// lista o WhatsApp entre os prestadores e não promete "nunca números". Também confere o fim das promessas de WhatsApp
// como canal do relatório (decisão do Lucca, 21/10).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const raiz = (p) => new URL(`../../${p}`, import.meta.url);
const texto = (h) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const politica = texto(await readFile(raiz("privacidade/index.html"), "utf8"));
const termos = texto(await readFile(raiz("termos/index.html"), "utf8"));

test("A3: a cópia pelo WhatsApp é descrita com precisão (totais incluídos, sem painel nem dados por campanha)", () => {
  assert.match(politica, /o mesmo texto do e-mail/);
  assert.match(politica, /totais como investimento, conversões e sessões/);
  assert.match(politica, /não vê o painel, os dados por campanha nem as suas contas/);
  assert.doesNotMatch(politica, /nunca os números brutos/);
  assert.match(politica, /consentimento \(art\. 7º, I\)/);
});

test("A3: WhatsApp está na tabela de prestadores e no 'Para quê'", () => {
  assert.match(politica, /WhatsApp \(Meta\) Envio da cópia do relatório do auditor, só para quem pedir/);
  assert.match(politica, /se você pedir, enviar a cópia do relatório pelo WhatsApp/);
});

test("C: Política e Termos citam a exclusão pela tela Conta e a conta grátis", () => {
  assert.match(politica, /Excluir minha conta/);
  assert.match(termos, /Conta grátis: uma retrospectiva por negócio/);
  assert.match(termos, /relatório chega no e-mail da sua conta e fica no seu painel/);
});
