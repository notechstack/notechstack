// Aba NF-e do painel (agentes/fiscal/conta/nfe.js): guarda estática contra os dois erros que a revisão de 17/11/2026
// achou: função declarada duas vezes (a segunda sobrescreve a primeira em silêncio) e id de elemento que não existe.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const raiz = new URL('../../agentes/fiscal/conta/', import.meta.url);
const js = readFileSync(new URL('nfe.js', raiz), 'utf8');
const html = readFileSync(new URL('index.html', raiz), 'utf8');

test('nfe.js não declara a mesma função duas vezes', () => {
  const nomes = [...js.matchAll(/^\s*function\s+([A-Za-z0-9_$]+)\s*\(/gm)].map((m) => m[1]);
  const repetidas = nomes.filter((n, i) => nomes.indexOf(n) !== i);
  assert.deepEqual(repetidas, []);
});

test('todo $(\'id\') de nfe.js existe em index.html', () => {
  const ids = [...new Set([...js.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((m) => m[1]))];
  const faltando = ids.filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(faltando, []);
});

test('o botão Conferir na Sefaz chama a conferência, e o formulário da planilha chama a leitura', () => {
  assert.match(js, /\$\('fa-nfe-conferir'\)\.addEventListener\('click', conferirSefaz\)/);
  assert.match(js, /\$\('fa-form-nfe-planilha'\)\.addEventListener\('submit', lerPlanilha\)/);
});

test('os modelos da planilha de NF-e linkados na aba existem e trazem as colunas de transporte', () => {
  const links = [...html.matchAll(/href="\/agentes\/fiscal\/dados\/(modelo-nfe\.(?:xlsx|csv))"/g)].map((m) => m[1]);
  assert.deepEqual(links.sort(), ['modelo-nfe.csv', 'modelo-nfe.xlsx']);
  const csv = readFileSync(new URL('../dados/modelo-nfe.csv', raiz), 'utf8');
  for (const c of ['modalidade_frete', 'transportador_cpf_cnpj', 'volumes_quantidade', 'peso_liquido', 'peso_bruto']) assert.ok(csv.includes(c), c);
  assert.ok(readFileSync(new URL('../dados/modelo-nfe.xlsx', raiz)).length > 1000);
});

test('o resumo da planilha mostra o transporte e os avisos de cada nota', () => {
  assert.match(js, /'Transporte: ' \+ n\.transporte/);
  assert.match(js, /n\.avisos/);
  assert.match(html, /<summary>Transporte e volumes<\/summary>/);
});
