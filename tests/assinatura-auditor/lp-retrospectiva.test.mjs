// LP do Auditor -> retrospectiva (Lucca, 16/10: "logo depois do usuario digitar a URL na LP!").
// Roda o auditor.js de verdade num DOM falso: diagnóstico entregue grava o resultado no sessionStorage e
// abre retrospectiva/#t01 com os utm_* e o fbclid; sem sessionStorage, o relatório fica na LP como antes;
// limite, teto e falha continuam na LP. A LP segue sem preço e sem checkout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const aqui = dirname(fileURLToPath(import.meta.url));
const repo = resolve(aqui, '..', '..');
const codigo = readFileSync(resolve(repo, 'agentes/auditor/auditor.js'), 'utf8');

const REPORT = {
  url: 'https://www.lojaexemplo.com.br/', gerado_em: '2026-10-16T19:00:00Z',
  resumo: { ok: 1, atencao: 1, problema: 0, nao_verificavel: 0 },
  checagens: [
    { id: 'https', titulo: 'Site em HTTPS', status: 'ok', evidencia: 'certificado válido' },
    { id: 'consentimento', titulo: 'Aviso de cookies', status: 'atencao', evidencia: 'aviso depois das tags' }
  ]
};

function el() {
  return {
    hidden: true, disabled: false, value: '', innerHTML: '', textContent: '', ouvintes: {}, attrs: {},
    addEventListener(t, f) { this.ouvintes[t] = f; },
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
    scrollIntoView() {}, focus() {}
  };
}

async function rodar({ status = 200, corpo = { status: 'entregue', report: REPORT, event_id: 'diag_x' }, semSession = false,
  pathname = '/agentes/auditor/', search = '?utm_source=meta&utm_campaign=c1&fbclid=abc&outro=z' } = {}) {
  const ids = Object.fromEntries(['au-form', 'au-url', 'au-submit', 'au-erro', 'au-estado', 'au-consent-grant',
    'au-consent-deny', 'au-cookies', 'au-consent-estado'].map((id) => [id, el()]));
  const sessao = new Map();
  const abertas = [];
  const janela = {};
  const ctx = {
    addEventListener(t, f) { janela[t] = f; },
    console, URL, URLSearchParams, JSON, Date, Math, Promise,
    setTimeout: (f) => { f(); return 0; },
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
    matchMedia: () => ({ matches: false }),
    localStorage: { getItem: () => 'denied', setItem() {} },
    sessionStorage: {
      setItem(k, v) { if (semSession) throw new Error('bloqueado'); sessao.set(k, String(v)); },
      getItem(k) { return sessao.has(k) ? sessao.get(k) : null; }
    },
    location: {
      hostname: 'notechstack.com.br', origin: 'https://notechstack.com.br', pathname, search,
      href: 'https://notechstack.com.br' + pathname + search, assign(u) { abertas.push(u); }
    },
    document: {
      cookie: '', getElementById: (id) => ids[id] || null, querySelectorAll: () => [], addEventListener() {}
    },
    fetch: async () => ({ status, text: async () => JSON.stringify(corpo) })
  };
  ctx.window = ctx;
  vm.runInNewContext(codigo, ctx);
  ids['au-url'].value = 'lojaexemplo.com.br';
  ids['au-form'].ouvintes.submit({ preventDefault() {} });
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  return { estado: ids['au-estado'].innerHTML, sessao, abertas, janela, ids, dataLayer: ctx.dataLayer || [] };
}

test('diagnóstico entregue: grava o resultado e abre a retrospectiva em #t01 com utm e fbclid', async () => {
  const { sessao, abertas, estado } = await rodar();
  const salvo = JSON.parse(sessao.get('no_auditor_diagnostico'));
  assert.equal(salvo.v, 1);
  assert.deepEqual(salvo.report, REPORT);
  assert.equal(abertas.length, 1);
  const u = new URL(abertas[0]);
  assert.equal(u.pathname, '/agentes/auditor/retrospectiva/');
  assert.equal(u.hash, '#t01');
  assert.equal(u.searchParams.get('utm_source'), 'meta');
  assert.equal(u.searchParams.get('utm_campaign'), 'c1');
  assert.equal(u.searchParams.get('fbclid'), 'abc');
  assert.equal(u.searchParams.get('outro'), null, 'só utm_* e fbclid seguem');
  assert.doesNotMatch(estado, /R\$|au-plano|au-checkout/, 'a LP continua sem preço e sem checkout');
});

test('LP aberta como index.html também leva à retrospectiva da mesma pasta', async () => {
  const { abertas } = await rodar({ pathname: '/agentes/auditor/index.html', search: '' });
  assert.equal(new URL(abertas[0]).pathname, '/agentes/auditor/retrospectiva/');
});

test('sem sessionStorage: o relatório aparece na LP como antes e nada é aberto', async () => {
  const { abertas, estado } = await rodar({ semSession: true });
  assert.equal(abertas.length, 0);
  assert.match(estado, /Diagnóstico inicial pronto/);
});

test('teto e falha continuam na LP, sem gravar nem abrir a retrospectiva', async () => {
  for (const [status, texto] of [[503, /teto diário/], [500, /Não conseguimos/]]) {
    const { abertas, sessao, estado } = await rodar({ status, corpo: {} });
    assert.equal(abertas.length, 0, `status ${status}`);
    assert.equal(sessao.size, 0, `status ${status}`);
    assert.match(estado, texto);
  }
});

// Lucca, 21/10: limite "invisível" (3 por dispositivo por dia). Sem aviso de cota na LP: vai direto à tela final
// da retrospectiva (?motivo=limite#t13), onde o "Refazer com outra conta" aparece travado.
test('limite (429): sem aviso de cota, abre a retrospectiva/?motivo=limite#t13 com utm e fbclid e mantém o evento', async () => {
  const { estado, dataLayer, abertas, sessao } = await rodar({ status: 429, corpo: { status: 'limite_usuario', limite: 3 } });
  assert.ok(dataLayer.some((e) => e && e.event === 'diagnostico_limite_usuario'), 'evento diagnostico_limite_usuario');
  assert.doesNotMatch(estado, /diagnósticos grátis|Ver os planos|assine um plano/, 'nenhum texto de cota na LP');
  assert.equal(sessao.size, 0, 'não grava diagnóstico novo');
  assert.equal(abertas.length, 1, 'navega direto para a tela final');
  const u = new URL(abertas[0]);
  assert.equal(u.pathname, '/agentes/auditor/retrospectiva/');
  assert.equal(u.searchParams.get('motivo'), 'limite');
  assert.equal(u.searchParams.get('utm_source'), 'meta');
  assert.equal(u.searchParams.get('utm_campaign'), 'c1');
  assert.equal(u.searchParams.get('fbclid'), 'abc');
  assert.equal(u.searchParams.get('outro'), null, 'só utm_*, fbclid e motivo');
  assert.equal(u.hash, '#t13');
});

test('voltar da retrospectiva pelo navegador: a LP volta a aceitar outra URL', async () => {
  const { janela, ids } = await rodar();
  assert.equal(ids['au-submit'].disabled, true, 'enquanto abre a retrospectiva, o botão fica travado');
  janela.pageshow({ persisted: true });
  assert.equal(ids['au-submit'].disabled, false);
  assert.equal(ids['au-estado'].innerHTML, '');
});
