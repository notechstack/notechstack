// S2 da LP do agente fiscal (.checks/agente-fiscal-lp.md, C4–C8): o simulador, rodando o fiscal.js de verdade no
// DOM falso, mostra o resumo antes da nota, emite a nota de demonstração, cancela com confirmação, para em 3 testes
// por navegador e não usa nenhuma API de rede.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrirPagina, campos, texto, JS, PRONTIA } from './pagina-falsa.mjs';

const temNota = (p) => p.mensagens().some((m) => /danfse-\d+\.pdf/.test(m.texto) || /\bnº \d+/.test(m.texto));
const restantes = (p) => {
  const m = /(\d+) testes? grátis/.exec(p.el('fi-sim-restantes').textContent);
  return m ? Number(m[1]) : 0;
};

test('resumo antes da nota', async () => {
  const p = abrirPagina();
  await p.enviar(PRONTIA);
  const resumo = p.mensagens().find((m) => m.el.querySelectorAll('button').some((b) => b.textContent === 'Confirmar emissão'));
  assert.ok(resumo, 'balão com o botão "Confirmar emissão"');
  const linhas = [...resumo.html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((m) => texto(m[1]));
  assert.ok(linhas.includes('Tomador Prontia Saúde'), linhas.join(' | '));
  assert.ok(linhas.includes('Valor R$ 10,00'), linhas.join(' | '));
  assert.ok(linhas.includes('Serviço Modelo “Prontia” · 04.01.01'), linhas.join(' | '));
  const botoes = resumo.el.querySelectorAll('button').map((b) => b.textContent);
  assert.deepEqual(botoes, ['Confirmar emissão', 'Corrigir']);
  assert.equal(temNota(p), false, 'nenhuma nota antes de confirmar');
});

test('"Corrigir" não emite e pede o que muda', async () => {
  const p = abrirPagina();
  await p.enviar(PRONTIA);
  await p.clicar('Corrigir');
  assert.equal(temNota(p), false);
  assert.equal(restantes(p), 3);
});

test('nota de demonstração e contador', async () => {
  const p = abrirPagina();
  const antes = restantes(p);
  assert.equal(antes, 3, 'começa com 3 testes grátis');
  await p.emitirProntia();
  const nota = p.mensagens().find((m) => /danfse-/.test(m.texto));
  assert.ok(nota, 'balão com a nota de demonstração');
  const n = (/\bnº (\d+)/.exec(nota.texto) || [])[1];
  assert.ok(n, 'número da nota');
  const c = campos(nota.html);
  assert.equal(c.Tomador, 'Prontia Saúde');
  assert.equal(c.Valor, 'R$ 10,00');
  assert.ok(c.Chave && c.Chave.length >= 10, `chave: ${c.Chave}`);
  assert.ok(nota.texto.includes(`danfse-${n}.pdf`), `danfse-${n}.pdf`);
  assert.ok(nota.texto.includes(`nfse-${n}.xml`), `nfse-${n}.xml`);
  assert.match(nota.texto, /simulação/i, 'marcada como simulação');
  assert.equal(restantes(p), antes - 1, 'o contador cai 1');
});

test('cancelamento simulado', async () => {
  const p = abrirPagina();
  await p.emitirProntia();
  await p.enviar('cancela a última nota');
  const pergunta = p.mensagens().at(-1);
  assert.deepEqual(pergunta.el.querySelectorAll('button').map((b) => b.textContent), ['Sim, cancelar', 'Manter a nota']);
  assert.ok(!p.mensagens().some((m) => /e101101 aceito/.test(m.texto)), 'nada cancelado antes de confirmar');
  await p.clicar('Sim, cancelar');
  const cancelada = p.mensagens().find((m) => /e101101 aceito/.test(m.texto));
  assert.ok(cancelada, '"e101101 aceito"');
  assert.match(cancelada.html, /<(\w+)\b[^>]*class="[^"]*carimbo[^"]*"[^>]*>\s*cancelada\s*<\/\1>/, 'carimbo "cancelada"');
});

test('"Manter a nota" não cancela', async () => {
  const p = abrirPagina();
  await p.emitirProntia();
  await p.enviar('cancela a última nota');
  await p.clicar('Manter a nota');
  assert.ok(!p.mensagens().some((m) => /e101101 aceito|>\s*cancelada\s*</.test(m.html)));
});

test('limite de 3 simulações', async () => {
  const navegador = new Map();
  const p = abrirPagina({ armazenamento: navegador });
  for (let i = 0; i < 3; i++) await p.emitirProntia();
  assert.equal(p.mensagens().filter((m) => /danfse-/.test(m.texto)).length, 3);

  // Recarregar no mesmo navegador: a contagem veio do localStorage.
  const q = abrirPagina({ armazenamento: navegador });
  await q.enviar(PRONTIA);
  const aviso = q.mensagens().at(-1);
  for (const termo of [/\bconta\b/, /CNPJ/, /\bA1\b/, /\bplano\b/, /7 dias grátis/]) assert.match(aviso.texto, termo);
  assert.equal(temNota(q), false, 'nenhuma nota nova depois do aviso');
  assert.ok(!q.botoes().includes('Confirmar emissão'), 'nem resumo para confirmar');
  assert.equal(restantes(q), 0);

  // Na mesma aba, uma 4ª mensagem também para no aviso.
  const antes = p.mensagens().filter((m) => /danfse-/.test(m.texto)).length;
  await p.enviar(PRONTIA);
  assert.match(p.mensagens().at(-1).texto, /7 dias grátis/);
  assert.equal(p.mensagens().filter((m) => /danfse-/.test(m.texto)).length, antes);
});

test('simulador sem rede', () => {
  for (const proibido of ['fetch(', 'XMLHttpRequest', 'sendBeacon']) assert.ok(!JS.includes(proibido), proibido);
});

test('nenhuma requisição durante a simulação', async () => {
  const p = abrirPagina();
  await p.emitirProntia();
  await p.enviar('cancela a última nota');
  await p.clicar('Sim, cancelar');
  await p.emitirProntia();
  await p.emitirProntia();
  await p.enviar(PRONTIA); // aviso de limite
  assert.equal(p.mensagens().filter((m) => /danfse-/.test(m.texto)).length, 3, 'a simulação completa rodou');
  assert.deepEqual(p.reg.rede, [], 'nenhuma API de rede chamada');
  assert.deepEqual(p.reg.criados.filter((t) => /^(script|img|iframe|link|audio|video|source|object|embed)$/.test(t)), []);
  for (const h of p.reg.html) assert.doesNotMatch(h, /<(img|script|iframe|link|audio|video|source|object|embed)\b|\ssrc=/i);
  assert.deepEqual(p.reg.navegou, [], 'nenhuma navegação');
});

test('o texto digitado não vai para o dataLayer', async () => {
  const p = abrirPagina();
  await p.emitirProntia();
  const camadas = JSON.stringify(p.dataLayer().map((e) => (e && typeof e === 'object' && 'length' in e ? Array.from(e) : e)));
  assert.ok(camadas.includes('fiscal_simulacao_emitida'), 'eventos da simulação existem');
  assert.ok(!/Prontia|10 reais/.test(camadas), 'sem o texto da mensagem');
});
