// Front da assinatura do Auditor (TASK-mvbcb35pbn0, decisões de Lucca em 16/10):
// (A) a LP do auditor volta ao aprovado: sem preço, sem seção de planos, sem assinatura.js. Os planos ficam só na
//     tela final da retrospectiva (retrospectiva/index.html, na raiz da pasta da TASK, fora do repo);
// (B) aceite único e obrigatório dos Termos: o relatório chega por e-mail e no painel (Lucca, 21/10; antes, WhatsApp).
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

const TEXTO_ACEITE = 'Li e aceito os Termos de Uso e a Política de Privacidade. Sei que o relatório do Auditor chega no meu e-mail e no meu painel do auditor.';
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
    assert.match(c, /WhatsApp/, `canal WhatsApp ${codigo}`);
    assert.match(c, new RegExp(`<button\\b[^>]*class="[^"]*au-plano-btn[^"]*"[^>]*data-plano="${codigo}"[^>]*\\bdisabled`), `botão ${codigo} começa desabilitado`);
  }
  assert.match(tela, /au-plano--recomendado[^>]*data-plano="semanal"/, 'Semanal é o recomendado');
  for (const outra of telas.slice(0, -1)) assert.doesNotMatch(outra[0], PRECO_RE, `preço só na tela final (${outra[1]})`);
});

// Rodada 5 (Lucca, 16/10): "tópicos diretos e descritivos"; os planos se diferenciam pelo ritmo do envio do relatório.
test('cartões diretos: até 4 tópicos curtos, ritmo do envio (mês, segunda, personalizado), sem "Para quem" nem Frequência/Canal', () => {
  assert.doesNotMatch(tela, /Para quem|Frequência|Canal/, 'sem os blocos longos da versão anterior');
  const ritmo = { mensal: /1 relatório por mês/i, semanal: /toda segunda/i, agencia: /personalizado/i };
  for (const c of cartoes) {
    const codigo = codigoDe(c);
    const itens = [...c.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((m) => textContent(m[1]));
    assert.ok(itens.length >= 3 && itens.length <= 4, `${codigo}: 3 ou 4 tópicos (tem ${itens.length})`);
    for (const i of itens) assert.ok(i.length <= 60, `${codigo}: tópico curto "${i}"`);
    assert.match(textContent(c), ritmo[codigo], `${codigo}: ritmo do envio no cartão`);
  }
});

// Rodada 5 (Lucca, 16/10): escolhe o plano → cadastro base (nome, sobrenome, e-mail, WhatsApp) e aceite dos Termos →
// só então abrem CPF/CNPJ, cartão e o endereço de cobrança que o Pagar.me pede.
test('checkout em duas etapas: cadastro base e aceite primeiro; documento, cartão e endereço só na etapa 2', () => {
  const e1 = html.match(/<fieldset class="au-fieldset" id="au-etapa-1">[\s\S]*?<\/fieldset>/)[0];
  const e2 =html.match(/<div class="au-etapa-2" id="au-etapa-2"[^>]*>[\s\S]*?<p class="au-checkout-msg"/)[0];
  for (const id of ['au-as-nome', 'au-as-sobrenome', 'au-as-email', 'au-as-telefone', 'au-ck-termos', 'au-checkout-continuar']) {
    assert.match(e1, new RegExp(`id="${id}"`), `etapa 1 tem #${id}`);
    assert.doesNotMatch(e2, new RegExp(`id="${id}"`), `#${id} não está na etapa 2`);
  }
  for (const id of ['au-as-documento', 'au-cc-numero', 'au-cc-nome', 'au-cc-validade', 'au-cc-cvv',
    'au-en-cep', 'au-en-rua', 'au-en-numero', 'au-en-complemento', 'au-en-bairro', 'au-en-cidade', 'au-en-uf']) {
    assert.match(e2, new RegExp(`id="${id}"`), `etapa 2 tem #${id}`);
    assert.doesNotMatch(e1, new RegExp(`id="${id}"`), `#${id} não está na etapa 1`);
  }
  assert.match(e2, /^<div class="au-etapa-2" id="au-etapa-2" hidden>/, 'etapa 2 começa fechada');
  assert.match(html, /<button type="submit"[^>]*id="au-checkout-assinar"[^>]*\bhidden\b/, '"Pagar e assinar" só aparece na etapa 2');
  assert.match(html, /<button type="button"[^>]*id="au-checkout-continuar"/, '"Continuar" não envia o formulário');
  const css = readFileSync(resolve(repo, '..', 'retrospectiva', 'planos.css'), 'utf8');
  assert.match(css, /\.au-checkout \[hidden\]\s*\{\s*display:\s*none !important/, 'etapa fechada some mesmo com display de .au-fieldset/.botao');
  assert.match(js, /if \(etapa2\.hidden\) \{ continuar\(\); return; \}/, 'Enter na etapa 1 vale como Continuar, nunca como pagamento');
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
const { validar, validarEtapa1, validarEtapa2, resumoEtapa1, montarPedido, mensagem, PLANOS, normalizarTexto } = ctx.window.noAssinatura;

const etapa1Ok = { plano: 'semanal', nome: 'Ana', sobrenome: 'Lima', email: 'ana@exemplo.com.br', telefone: '(11) 99999-0000', termos_aceite: true };
const dadosOk = {
  ...etapa1Ok, documento: '123.456.789-09',
  numero_cartao: '4000 0000 0000 0010', nome_cartao: 'ANA LIMA', validade: '12/30', cvv: '123',
  endereco: { cep: '01001-000', rua: ' Praça da Sé ', numero: '100', complemento: '', bairro: 'Sé', cidade: 'São Paulo', uf: 'sp' }
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

test('etapa 1 valida só o cadastro base e o aceite; etapa 2 só documento, cartão e endereço', () => {
  assert.deepEqual([...validarEtapa1(etapa1Ok)], [], 'etapa 1 completa sem pedir cartão');
  assert.ok(validarEtapa1({ ...etapa1Ok, sobrenome: ' ' }).some((e) => /sobrenome/.test(e)), 'sobrenome obrigatório');
  assert.ok(validarEtapa1({ ...etapa1Ok, termos_aceite: false }).some((e) => /Termos de Uso/.test(e)), 'aceite na etapa 1');
  assert.ok(validarEtapa2(etapa1Ok).length > 0, 'etapa 2 vazia não passa');
  assert.deepEqual([...validarEtapa2(dadosOk)], []);
  for (const ruim of [{ cep: '0100100' }, { uf: 'XX' }, { rua: '' }, { numero: ' ' }, { bairro: '' }, { cidade: '' }]) {
    const erros = validarEtapa2({ ...dadosOk, endereco: { ...dadosOk.endereco, ...ruim } });
    assert.ok(erros.some((e) => /endereço de cobrança/.test(e)), `endereço ${JSON.stringify(ruim)} → erro`);
  }
  assert.equal(resumoEtapa1(dadosOk), 'Ana Lima · ana@exemplo.com.br · WhatsApp (11) 99999-0000');
  assert.equal(resumoEtapa1({ ...dadosOk, telefone: '1133334444' }), 'Ana Lima · ana@exemplo.com.br · WhatsApp (11) 3333-4444');
});

test('montarPedido: corpo exato (plano, nome, email, documento, telefone, card_token, termos_aceite, aceite_texto, endereco), sem cartão', () => {
  const pedido = montarPedido(dadosOk, 'token_abc', textoDoLabel);
  assert.deepEqual(Object.keys(pedido).sort(), ['aceite_texto', 'card_token', 'documento', 'email', 'endereco', 'nome', 'plano', 'telefone', 'termos_aceite']);
  assert.equal(pedido.nome, 'Ana Lima', 'nome e sobrenome juntos, como o Pagar.me recebe');
  assert.deepEqual({ ...pedido.endereco }, { cep: '01001000', rua: 'Praça da Sé', numero: '100', complemento: '', bairro: 'Sé', cidade: 'São Paulo', uf: 'SP' });
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

test('validar: celular é obrigatório (vazio ou sem DDD dá erro)', () => {
  for (const tel of ['', '   ', '9999-0000', '11 99999-00001']) {
    const erros = validar({ ...dadosOk, telefone: tel });
    assert.ok(erros.some((e) => /celular/i.test(e)), `telefone "${tel}" → erro de celular`);
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

// ── Rodada 3: a retrospectiva do site (logo depois da URL na LP) tem a MESMA tela de planos do protótipo ──
// Todas as provas acima sobre a tela final valem para a cópia do site porque a seção t13 é idêntica.
test('retrospectiva do site: tela de planos idêntica à do protótipo e JS da assinatura pela pasta da LP', () => {
  const site = readFileSync(resolve(repo, 'agentes/auditor/retrospectiva/index.html'), 'utf8');
  const t13 = (h) => lf(h).match(/<section id="t13"[\s\S]*?<\/section>/)[0];
  assert.equal(t13(site), t13(html));
  const telasSite = [...site.matchAll(/<section\b[^>]*\bdata-estado="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(telasSite.at(-1), 'planos', 'planos continua sendo a última tela');
  assert.match(site, /<script src="\.\.\/assinatura-medicao\.js"><\/script>/);
  assert.match(site, /<script src="\.\.\/assinatura\.js"><\/script>/);
  assert.doesNotMatch(site, /(src|href)="\/repo\//, 'nenhum arquivo carregado pelo caminho da mesa (/repo/) na cópia do site');
});
