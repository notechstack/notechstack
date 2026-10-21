// S3 da LP do agente fiscal (.checks/agente-fiscal-lp.md, C9): medição só com consentimento. Roda os scripts inline
// do index.html (o consentimento padrão, antes do GTM) e o fiscal.js no DOM falso; recarregar = nova página com o
// mesmo localStorage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrirPagina } from './pagina-falsa.mjs';

const SINAIS = ['ad_storage', 'ad_user_data', 'ad_personalization', 'analytics_storage'];
const consent = (p, tipo) => p.dataLayer().filter((e) => e && e[0] === 'consent' && e[1] === tipo).map((e) => e[2]);
const todos = (obj, valor) => SINAIS.every((s) => obj && obj[s] === valor);

test('consentimento padrão negado e escolha gravada', () => {
  // Sem escolha: padrão denied nos 4 sinais, estado "recusada", aviso aberto.
  const p = abrirPagina();
  const padrao = consent(p, 'default');
  assert.equal(padrao.length, 1, 'um consent default');
  assert.ok(todos(padrao[0], 'denied'), JSON.stringify(padrao[0]));
  assert.ok(consent(p, 'update').every((u) => todos(u, 'denied')), 'nada é liberado sem escolha');
  assert.equal(p.el('fi-consent-estado').textContent, 'recusada');
  assert.equal(p.el('fi-cookies').hidden, false, 'o aviso de cookies aparece');

  // "Permitir medição": granted nos 4 sinais e a escolha fica gravada.
  const navegador = new Map();
  const a = abrirPagina({ armazenamento: navegador });
  a.el('fi-consent-grant').disparar('click', {});
  assert.ok(todos(consent(a, 'update').at(-1), 'granted'), 'update granted');
  assert.equal(a.el('fi-cookies').hidden, true);
  const a2 = abrirPagina({ armazenamento: navegador });
  assert.ok(todos(consent(a2, 'default')[0], 'granted'), 'ao recarregar, o padrão já vem granted');
  assert.equal(a2.el('fi-cookies').hidden, true, 'não pergunta de novo');
  assert.notEqual(a2.el('fi-consent-estado').textContent, 'recusada');

  // "Recusar": continua denied, e a recusa também fica gravada.
  const outro = new Map();
  const r = abrirPagina({ armazenamento: outro });
  r.el('fi-consent-deny').disparar('click', {});
  assert.ok(todos(consent(r, 'update').at(-1), 'denied'), 'update denied');
  assert.equal(r.el('fi-consent-estado').textContent, 'recusada');
  const r2 = abrirPagina({ armazenamento: outro });
  assert.ok(todos(consent(r2, 'default')[0], 'denied'));
  assert.equal(r2.el('fi-cookies').hidden, true, 'a recusa foi gravada');
});
