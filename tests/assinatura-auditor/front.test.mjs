// Front da assinatura do Auditor: HTML da seção de planos + funções puras de assinatura.js (sem DOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const aqui = dirname(fileURLToPath(import.meta.url));
const raiz = resolve(aqui, '..', '..');
const html = readFileSync(resolve(raiz, 'agentes/auditor/index.html'), 'utf8');
const js = readFileSync(resolve(raiz, 'agentes/auditor/assinatura.js'), 'utf8');

function tag(id) {
  const m = html.match(new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`));
  assert.ok(m, `input #${id} existe`);
  return m[0];
}

test('seção #planos existe com os 3 planos e preços aprovados', () => {
  const m = html.match(/<section\b[^>]*\bid="planos"[^>]*>([\s\S]*?)<\/section>/);
  assert.ok(m, 'section id="planos" existe');
  const secao = m[1];
  for (const nome of ['Mensal', 'Semanal', 'Agência']) assert.match(secao, new RegExp(nome));
  for (const preco of ['R$ 47', 'R$ 97', 'R$ 197']) assert.ok(secao.includes(preco), `preço ${preco}`);
  assert.doesNotMatch(secao, /a definir/i);
  for (const codigo of ['mensal', 'semanal', 'agencia']) {
    assert.match(secao, new RegExp(`<button\\b[^>]*data-plano="${codigo}"[^>]*\\bdisabled`), `botão ${codigo} começa desabilitado`);
  }
});

test('caixa do relatório no WhatsApp é separada dos termos, sem checked e sem required', () => {
  const relatorio = tag('au-ck-relatorio');
  const termos = tag('au-ck-termos');
  assert.notEqual(relatorio, termos);
  assert.ok(relatorio.indexOf('au-ck-termos') === -1 && termos.indexOf('au-ck-relatorio') === -1, 'elementos diferentes');
  assert.doesNotMatch(relatorio, /\bchecked\b/);
  assert.doesNotMatch(relatorio, /\brequired\b/);
  assert.match(termos, /\brequired\b/);
  assert.match(html, /<span\b[^>]*\bid="au-ck-relatorio-texto"[^>]*>/);
});

test('inputs do cartão não têm atributo name', () => {
  const cartao = html.match(/<input\b[^>]*autocomplete="cc-[a-z]+"[^>]*>/g) || [];
  assert.equal(cartao.length, 4, 'número, nome impresso, validade e CVV');
  for (const t of cartao) assert.doesNotMatch(t, /\bname=/, `sem name: ${t}`);
});

// assinatura.js sem document: só expõe window.noAssinatura.
const ctx = { window: {} };
vm.runInNewContext(js, ctx, { filename: 'assinatura.js' });
const { validar, montarPedido, mensagem, PLANOS } = ctx.window.noAssinatura;

const dadosOk = {
  plano: 'semanal', nome: 'Ana Lima', email: 'ana@exemplo.com.br', documento: '123.456.789-09', telefone: '(11) 99999-0000',
  numero_cartao: '4000 0000 0000 0010', nome_cartao: 'ANA LIMA', validade: '12/30', cvv: '123',
  termos_aceite: true, relatorio_aceite: true
};

test('PLANOS e validar ok', () => {
  assert.deepEqual(Object.keys(PLANOS), ['mensal', 'semanal', 'agencia']);
  assert.equal(PLANOS.mensal.valor, 47);
  assert.equal(PLANOS.semanal.valor, 97);
  assert.equal(PLANOS.agencia.valor, 197);
  const erros = validar(dadosOk);
  assert.equal(erros.length, 0, `dados completos sem erro: ${erros.join(' | ')}`);
});

test('montarPedido nunca leva dado de cartão', () => {
  const pedido = montarPedido(dadosOk, 'token_abc', 'Quero receber o relatório.');
  const proibidas = ['number', 'cvv', 'holder_name', 'exp_month', 'exp_year', 'card', 'numero_cartao', 'nome_cartao', 'validade'];
  for (const k of proibidas) assert.ok(!(k in pedido), `sem chave ${k}`);
  assert.equal(pedido.card_token, 'token_abc');
  assert.equal(pedido.documento, '12345678909');
  assert.equal(pedido.telefone, '11999990000');
  assert.equal(pedido.relatorio_aceite, true);
  assert.equal(pedido.relatorio_aceite_texto, 'Quero receber o relatório.');
  assert.equal(pedido.termos_aceite, true);
  assert.ok(!JSON.stringify(pedido).includes('4000'), 'número do cartão não aparece no JSON');
});

test('relatorio_aceite false → texto null', () => {
  const pedido = montarPedido({ ...dadosOk, relatorio_aceite: false, telefone: '' }, 'tok', 'texto');
  assert.equal(pedido.relatorio_aceite, false);
  assert.equal(pedido.relatorio_aceite_texto, null);
  assert.ok(!('telefone' in pedido), 'telefone omitido quando vazio');
});

test('validar: aceite do relatório sem telefone dá erro', () => {
  const erros = validar({ ...dadosOk, telefone: '' });
  assert.ok(erros.length > 0);
  assert.ok(erros.some((e) => /telefone/i.test(e)));
});

test('validar: sem termos dá erro', () => {
  const erros = validar({ ...dadosOk, termos_aceite: false });
  assert.ok(erros.some((e) => /Termos/i.test(e)));
});

test('mensagem por status', () => {
  assert.match(mensagem({ ok: true, status: 'paga' }), /^Assinatura confirmada\./);
  assert.equal(mensagem({ ok: true, status: 'pendente' }), 'Recebemos sua assinatura. A confirmação do pagamento chega em instantes.');
  assert.equal(mensagem({ ok: false, mensagem: 'Cartão recusado.' }), 'Cartão recusado.');
  assert.equal(mensagem(null), 'Não deu para concluir agora. Tente de novo em alguns minutos.');
});

test("medicao do checkout segurada: so com venda aberta e medicao_liberada da funcao", async () => {
  const { readFile: rf } = await import("node:fs/promises");
  const vmod = await import("node:vm");
  const ctx = vmod.createContext({ window: {} });
  vmod.runInContext(await rf(new URL("../../agentes/auditor/assinatura.js", import.meta.url), "utf8"), ctx);
  const liberada = ctx.window.noAssinatura.medicaoLiberada;
  assert.equal(liberada({ venda_aberta: true }), false);
  assert.equal(liberada({ venda_aberta: true, medicao_liberada: false }), false);
  assert.equal(liberada({ venda_aberta: false, medicao_liberada: true }), false);
  assert.equal(liberada(null), false);
  assert.equal(liberada({ venda_aberta: true, medicao_liberada: true }), true);
});
