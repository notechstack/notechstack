// S4 da LP do agente fiscal (.checks/agente-fiscal-lp.md, C10–C12): o que a página promete. Lê o index.html (HTML e
// JSON-LD) e os textos que o simulador escreve (fiscal.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { HTML, repo, ler, texto } from './pagina-falsa.mjs';

const PROIBIDAS = ['Facebook', 'Meta Login', 'separado do banco', 'fora do banco', 'Nenhuma rota', 'Em segundos', 'Prioridade na fila'];

const arquivos = readdirSync(resolve(repo, 'agentes/fiscal')).filter((f) => /\.(html|js|css)$/.test(f)).map((f) => 'agentes/fiscal/' + f);
const jsonLd = () => [...HTML.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const strings = (v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);

// Filhos <li> de primeiro nível do primeiro elemento com essa classe, contando o aninhamento de <li>.
function itens(html, classe) {
  const ini = new RegExp(`<(ul|ol)\\b[^>]*class="[^"]*\\b${classe}\\b[^"]*"[^>]*>`).exec(html);
  assert.ok(ini, `lista .${classe}`);
  const re = new RegExp(`<li\\b[^>]*>|</li>|<${ini[1]}\\b[^>]*>|</${ini[1]}>`, 'g');
  re.lastIndex = ini.index + ini[0].length;
  const saida = []; let li = 0, lista = 0, comeco = 0, m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith('<li')) { if (li++ === 0 && lista === 0) comeco = m.index; }
    else if (m[0] === '</li>') { if (--li === 0 && lista === 0) saida.push(html.slice(comeco, m.index + 5)); }
    else if (m[0].startsWith('</')) { if (lista-- === 0) break; }
    else lista++;
  }
  return saida;
}

test('sem afirmações proibidas', () => {
  const fontes = arquivos.map((f) => ({ f, cru: ler(f) }));
  assert.ok(fontes.some((x) => x.f.endsWith('index.html')) && fontes.some((x) => x.f.endsWith('fiscal.js')));
  const blocos = jsonLd();
  assert.ok(blocos.length > 0, 'a página tem JSON-LD');
  const ld = blocos.flatMap((b) => strings(JSON.parse(b))).join('\n');
  for (const frase of PROIBIDAS) {
    const re = new RegExp(frase.replace(/ /g, '\\s+'), 'i');
    for (const { f, cru } of fontes) {
      assert.doesNotMatch(cru, re, `${f}: "${frase}"`);
      assert.doesNotMatch(texto(cru), re, `${f} (texto): "${frase}"`);
    }
    assert.doesNotMatch(ld, re, `JSON-LD: "${frase}"`);
  }
});

test('a renovação do A1 nunca é pedida "por aqui"', () => {
  for (const f of arquivos) {
    const frases = texto(ler(f)).split(/(?<=[.!?])\s+/);
    for (const fr of frases.filter((x) => /renov/i.test(x))) assert.doesNotMatch(fr, /por aqui/i, `${f}: ${fr}`);
  }
});

// Decisão de Lucca em 22/10/2026: sem o cartão "Teste"; 5 primeiras emissões grátis no lugar dos 7 dias; o
// sob medida se divide em Escritório (mais de 100 notas no próprio negócio) e Agência (vários CNPJs).
test('planos da decisão de 22/10', () => {
  const secao = /<section\b[^>]*id="planos"[^>]*>([\s\S]*?)<\/section>/.exec(HTML);
  assert.ok(secao, 'seção #planos');
  const cartoes = itens(secao[1], 'fi-planos').map((html) => ({
    html, nome: texto((/<h3\b[^>]*>([^<]*)/.exec(html) || [])[1] || ''), txt: texto(html),
    acoes: [...html.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/g)].map((m) => ({ rotulo: texto(m[3]), href: (/href="([^"]*)"/.exec(m[2]) || [])[1] }))
  }));
  assert.deepEqual(cartoes.map((c) => c.nome), ['Inicial', 'Pro', 'Escritório', 'Agência']);
  const [inicial, pro, escritorio, agencia] = cartoes;

  assert.match(inicial.txt, /R\$ 49(?![\d,])/);
  assert.match(inicial.txt, /até 20 notas/i);
  // Critério 51 da tarefa agente-fiscal-v2: o botão leva ao cadastro no site.
  assert.ok(inicial.acoes.some((a) => a.rotulo === 'Começar com 5 notas grátis' && a.href === '/agentes/fiscal/comecar/?plano=inicial'), 'Inicial: "Começar com 5 notas grátis"');

  assert.match(pro.txt, /R\$ 129(?![\d,])/);
  assert.match(pro.txt, /até 100 notas/i);
  assert.match(pro.txt, /cópia[^.]*cliente[^.]*contador/i);
  assert.match(pro.txt, /resumo das notas/i);
  assert.ok(pro.acoes.some((a) => a.rotulo === 'Começar com 5 notas grátis' && a.href === '/agentes/fiscal/comecar/?plano=pro'), 'Pro: "Começar com 5 notas grátis"');

  for (const c of [escritorio, agencia]) {
    assert.match(c.txt, /sob medida/i);
    assert.ok(c.acoes.some((a) => a.rotulo === 'Falar com a Nó' && a.href && a.href.startsWith('https://wa.me/5511939289413?text=')), `${c.nome}: WhatsApp comercial`);
  }
  assert.match(escritorio.txt, /mais de 100 notas/i);
  assert.match(agencia.txt, /certificado A1 por cliente/i);

  for (const c of [inicial, pro]) assert.ok(!c.acoes.some((a) => a.href && /pagar|checkout|app\./i.test(a.href)), `${c.nome}: sem link de assinatura`);
  assert.match(texto(secao[1]), /5 emissões são gratuitas/);
  assert.doesNotMatch(texto(secao[1]), /7 dias/);
});

test('FAQ e JSON-LD coerentes', () => {
  const faq = new Map([...HTML.matchAll(/<details\b[^>]*>\s*<summary\b[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g)]
    .map((m) => [texto(m[1]), texto(m[2])]));
  const valida = faq.get('Como sei que a nota é válida?');
  assert.ok(valida, 'pergunta "Como sei que a nota é válida?"');
  assert.match(valida, /QR Code/);
  assert.match(valida, /nfse\.gov\.br/);

  const docs = jsonLd().map((b) => JSON.parse(b)).flatMap((d) => (Array.isArray(d) ? d : d['@graph'] || [d]));
  const pagina = docs.find((d) => d['@type'] === 'FAQPage');
  assert.ok(pagina, 'JSON-LD FAQPage');
  assert.ok(Array.isArray(pagina.mainEntity) && pagina.mainEntity.length > 0);
  for (const q of pagina.mainEntity) {
    assert.equal(q['@type'], 'Question');
    assert.equal(q.acceptedAnswer && q.acceptedAnswer['@type'], 'Answer');
    assert.ok(faq.has(q.name), `"${q.name}" está no FAQ do HTML`);
    assert.equal(q.acceptedAnswer.text.replace(/\s+/g, ' ').trim(), faq.get(q.name), `resposta de "${q.name}"`);
  }
  assert.ok(pagina.mainEntity.some((q) => q.name === 'Como sei que a nota é válida?'));
});
