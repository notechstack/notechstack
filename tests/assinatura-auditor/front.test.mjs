// Front da assinatura do Auditor (TASK-mvbcb35pbn0, decisões de Lucca em 16/10):
// (A) a LP do auditor volta ao aprovado: sem preço, sem seção de planos, sem assinatura.js. Os planos ficam só na
//     tela final da retrospectiva (retrospectiva/index.html, na raiz da pasta da TASK, fora do repo);
// (B) aceite único e obrigatório dos Termos, que já diz que o relatório chega no WhatsApp informado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const aqui = dirname(fileURLToPath(import.meta.url));
const repo = resolve(aqui, '..', '..');
const lp = readFileSync(resolve(repo, 'agentes/auditor/index.html'), 'utf8');
const lpCss = readFileSync(resolve(repo, 'agentes/auditor/auditor.css'), 'utf8');
const html = readFileSync(resolve(repo, '..', 'retrospectiva', 'index.html'), 'utf8');
const js = readFileSync(resolve(repo, 'agentes/auditor/assinatura.js'), 'utf8');

const TEXTO_ACEITE = 'Li e aceito os Termos de Uso e a Política de Privacidade. Sei que o relatório do Auditor chega no WhatsApp que informei acima, enviado pelo número da nó (+55 11 93928-9413).';
const PRECO_RE = /R\$\s*(47|97|197)\b/;
const lf = (s) => s.replace(/\r\n/g, '\n');
const textContent = (h) => h.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const deMain = (caminho) => execFileSync('git', ['show', `origin/main:${caminho}`], { cwd: repo, encoding: 'utf8' });

function tag(id) {
  const m = html.match(new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`));
  assert.ok(m, `input #${id} existe`);
  return m[0];
}

// ── (A) LP aprovada, sem planos ──
test('LP do auditor: nenhum preço R$ 47/97/197, sem seção de planos, não carrega assinatura.js', () => {
  assert.doesNotMatch(lp, PRECO_RE, 'nenhum R$ 47/97/197 na LP');
  assert.doesNotMatch(lp, /id="planos"|au-plano|au-checkout/, 'sem seção de planos nem checkout');
  assert.doesNotMatch(lp, /assinatura(-medicao)?\.js/, 'LP não carrega assinatura.js nem assinatura-medicao.js');
});

test('LP do auditor (index.html e auditor.css) é igual à de origin/main', () => {
  assert.equal(lf(lp), lf(deMain('agentes/auditor/index.html')));
  assert.equal(lf(lpCss), lf(deMain('agentes/auditor/auditor.css')));
});

// ── Tela final da retrospectiva ──
const telas = [...html.matchAll(/<section\b[^>]*\bdata-estado="([^"]*)"[^>]*>[\s\S]*?<\/section>/g)];
const ultima = telas.at(-1);
const tela = ultima[0];
// só os cartões de plano (não o lead nem a nota, que são .au-planos-*)
const cartoes = tela.split(/<div class="cartao au-plano(?=[ "])/).slice(1);
const codigoDe = (c) => c.match(/data-plano="(\w+)"/)[1];

test('a última tela da retrospectiva é a de planos: 3 planos da T1, preço dentro de cada cartão, sem "a definir"', () => {
  assert.equal(ultima[1], 'planos');
  assert.match(tela, /\bid="planos"/, 'assinatura.js só liga com #planos na página');
  assert.doesNotMatch(tela, /a definir/i);
  assert.deepEqual(cartoes.map(codigoDe), ['mensal', 'semanal', 'agencia']);
  const esperado = { mensal: ['Mensal', 'R$ 47'], semanal: ['Semanal', 'R$ 97'], agencia: ['Agência', 'R$ 197'] };
  for (const c of cartoes) {
    const codigo = codigoDe(c);
    const [nome, preco] = esperado[codigo];
    assert.ok(c.includes(nome), `nome ${nome}`);
    assert.ok(c.includes(preco), `preço ${preco} dentro do cartão ${codigo}`);
    assert.match(c, /Frequência/, `frequência ${codigo}`);
    assert.match(c, /Canal/, `canal ${codigo}`);
    assert.match(c, /WhatsApp/, `canal WhatsApp ${codigo}`);
    assert.match(c, new RegExp(`<button\\b[^>]*class="[^"]*au-plano-btn[^"]*"[^>]*data-plano="${codigo}"[^>]*\\bdisabled`), `botão ${codigo} começa desabilitado`);
  }
  assert.match(tela, /au-plano--recomendado[^>]*data-plano="semanal"/, 'Semanal é o recomendado');
  for (const outra of telas.slice(0, -1)) assert.doesNotMatch(outra[0], PRECO_RE, `preço só na tela final (${outra[1]})`);
});

test('tela final carrega assinatura.js e assinatura-medicao.js do repo por caminho absoluto, sem CDN novo', () => {
  assert.match(html, /<script\b[^>]*src="\/repo\/agentes\/auditor\/assinatura-medicao\.js[^"]*"/);
  assert.match(html, /<script\b[^>]*src="\/repo\/agentes\/auditor\/assinatura\.js[^"]*"/);
  assert.match(html, /<link\b[^>]*href="planos\.css"/);
  assert.doesNotMatch(html, /<(script|link)\b[^>]*\b(src|href)="(https?:)?\/\//, 'nenhum script ou css de CDN');
});

test('checkout: uma só caixa obrigatória com o texto do aceite, WhatsApp obrigatório, nenhuma caixa do relatório', () => {
  const caixas = (html.match(/<input\b[^>]*type="checkbox"[^>]*>/g) || []).filter((t) => /au-ck-/.test(t));
  assert.equal(caixas.length, 1, 'uma única caixa de aceite no checkout');
  const termos = tag('au-ck-termos');
  assert.match(termos, /\brequired\b/);
  assert.doesNotMatch(termos, /\bchecked\b/, 'desmarcada por padrão');
  assert.doesNotMatch(html, /au-ck-relatorio|relatorio_aceite/, 'sem caixa separada do relatório');
  const label = html.match(/<label\b[^>]*for="au-ck-termos"[^>]*>([\s\S]*?)<\/label>/);
  assert.ok(label, 'label do aceite');
  assert.equal(textContent(label[1]), TEXTO_ACEITE);
  assert.match(label[1], /<a\b[^>]*href="\/termos\/?"[^>]*>Termos de Uso<\/a>/);
  assert.match(label[1], /<a\b[^>]*href="\/privacidade\/?"[^>]*>Política de Privacidade<\/a>/);
  assert.match(label[0], /\bid="au-ck-termos-rotulo"/, 'assinatura.js lê o textContent deste label');
  assert.match(js, /au-ck-termos-rotulo/);
  const tel = tag('au-as-telefone');
  assert.match(tel, /\brequired\b/);
  const labelTel = html.match(/<label\b[^>]*for="au-as-telefone"[^>]*>([\s\S]*?)<\/label>/);
  assert.equal(textContent(labelTel[1]), 'WhatsApp (com DDD)');
});

test('inputs do cartão não têm atributo name', () => {
  const cartao = html.match(/<input\b[^>]*autocomplete="cc-[a-z]+"[^>]*>/g) || [];
  assert.equal(cartao.length, 4, 'número, nome impresso, validade e CVV');
  for (const t of cartao) assert.doesNotMatch(t, /\bname=/, `sem name: ${t}`);
});

// ── assinatura.js sem document: só expõe window.noAssinatura ──
const ctx = { window: {} };
vm.runInNewContext(js, ctx, { filename: 'assinatura.js' });
const { validar, montarPedido, mensagem, PLANOS, normalizarTexto } = ctx.window.noAssinatura;

const dadosOk = {
  plano: 'semanal', nome: 'Ana Lima', email: 'ana@exemplo.com.br', documento: '123.456.789-09', telefone: '(11) 99999-0000',
  numero_cartao: '4000 0000 0000 0010', nome_cartao: 'ANA LIMA', validade: '12/30', cvv: '123',
  termos_aceite: true
};
const labelHtml = html.match(/<label\b[^>]*for="au-ck-termos"[^>]*>([\s\S]*?)<\/label>/)[1];
const textoDoLabel = labelHtml.replace(/<[^>]+>/g, ''); // o que o navegador devolve em textContent (sem normalizar)

test('PLANOS e validar ok', () => {
  assert.deepEqual(Object.keys(PLANOS), ['mensal', 'semanal', 'agencia']);
  assert.equal(PLANOS.mensal.valor, 47);
  assert.equal(PLANOS.semanal.valor, 97);
  assert.equal(PLANOS.agencia.valor, 197);
  const erros = validar(dadosOk);
  assert.equal(erros.length, 0, `dados completos sem erro: ${erros.join(' | ')}`);
});

test('montarPedido: corpo exato (plano, nome, email, documento, telefone, card_token, termos_aceite, aceite_texto), sem cartão', () => {
  const pedido = montarPedido(dadosOk, 'token_abc', textoDoLabel);
  assert.deepEqual(Object.keys(pedido).sort(), ['aceite_texto', 'card_token', 'documento', 'email', 'nome', 'plano', 'telefone', 'termos_aceite']);
  assert.equal(pedido.plano, 'semanal');
  assert.equal(pedido.card_token, 'token_abc');
  assert.equal(pedido.documento, '12345678909');
  assert.equal(pedido.telefone, '11999990000');
  assert.equal(pedido.termos_aceite, true);
  assert.equal(pedido.aceite_texto, TEXTO_ACEITE);
  assert.ok(!('relatorio_aceite' in pedido) && !('relatorio_aceite_texto' in pedido), 'sem relatorio_aceite');
  const proibidas = ['number', 'cvv', 'holder_name', 'exp_month', 'exp_year', 'card', 'numero_cartao', 'nome_cartao', 'validade'];
  for (const k of proibidas) assert.ok(!(k in pedido), `sem chave ${k}`);
  assert.ok(!JSON.stringify(pedido).includes('4000'), 'número do cartão não aparece no JSON');
});

test('normalizarTexto: espaços e quebras viram um espaço só', () => {
  assert.equal(normalizarTexto('  Li e aceito \n  os   Termos. '), 'Li e aceito os Termos.');
  assert.equal(montarPedido(dadosOk, 'tok', ' ' + TEXTO_ACEITE.replace(' Sei', '\n   Sei') + '\n').aceite_texto, TEXTO_ACEITE);
});

test('validar: WhatsApp é obrigatório (vazio ou sem DDD dá erro)', () => {
  for (const tel of ['', '   ', '9999-0000', '11 99999-00001']) {
    const erros = validar({ ...dadosOk, telefone: tel });
    assert.ok(erros.some((e) => /WhatsApp/i.test(e)), `telefone "${tel}" → erro de WhatsApp`);
  }
});

test('validar: sem marcar o aceite não envia e mostra a mensagem dos Termos', () => {
  for (const aceite of [false, undefined, 'true']) {
    const erros = validar({ ...dadosOk, termos_aceite: aceite });
    assert.ok(erros.some((e) => /Termos de Uso/.test(e)), `aceite ${aceite} → erro de Termos`);
  }
});

test('mensagem por status', () => {
  assert.match(mensagem({ ok: true, status: 'paga' }), /^Assinatura confirmada\./);
  assert.equal(mensagem({ ok: true, status: 'pendente' }), 'Recebemos sua assinatura. A confirmação do pagamento chega em instantes.');
  assert.equal(mensagem({ ok: false, mensagem: 'Cartão recusado.' }), 'Cartão recusado.');
  assert.equal(mensagem(null), 'Não deu para concluir agora. Tente de novo em alguns minutos.');
});

test('medicao do checkout segurada: so com venda aberta e medicao_liberada da funcao', () => {
  const liberada = ctx.window.noAssinatura.medicaoLiberada;
  assert.equal(liberada({ venda_aberta: true }), false);
  assert.equal(liberada({ venda_aberta: true, medicao_liberada: false }), false);
  assert.equal(liberada({ venda_aberta: false, medicao_liberada: true }), false);
  assert.equal(liberada(null), false);
  assert.equal(liberada({ venda_aberta: true, medicao_liberada: true }), true);
});
