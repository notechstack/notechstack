// C56 (lote E de .checks/agente-fiscal-v2.md, critério 56): os dublês só existem em tools/fiscal-demo/ e só a
// demonstração aponta para eles; no código de produção, as 5 variáveis de URL base, onde são lidas, caem na URL
// oficial; o config.js de produção não tem nada local. Mais os servidores da demo (trailingSlash, proxy, wa.me).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative, dirname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import vm from 'node:vm';
import { repo, ler } from './pagina-falsa.mjs';

const OFICIAIS = {
  PAGARME_ASSINATURA_API_URL: 'https://api.pagar.me/core/v5',
  RESEND_API_URL: 'https://api.resend.com',
  WHATSAPP_GRAPH_URL: 'https://graph.facebook.com',
  ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
  CNPJ_API_URL: 'https://brasilapi.com.br'
};
const IGNORAR = new Set(['.git', 'node_modules', '.vercel', '.claude', 'dist']);

function arquivos(dir, filtro, saida = []) {
  let itens;
  try { itens = readdirSync(dir); } catch { return saida; }
  for (const nome of itens) {
    if (IGNORAR.has(nome)) continue;
    const p = resolve(dir, nome);
    let info;
    try { info = statSync(p); } catch { continue; }
    if (info.isDirectory()) arquivos(p, filtro, saida);
    else if (filtro(p)) saida.push(p);
  }
  return saida;
}
const rel = (p) => relative(repo, p).split(sep).join('/');
const codigo = (p) => /\.(m?js|cjs|ts|tsx|html)$/.test(p);
const producao = () => [
  ...arquivos(resolve(repo, 'agentes', 'fiscal'), codigo),
  ...arquivos(resolve(repo, 'app', 'api'), (p) => codigo(p) && !/\.test\.ts$/.test(p) && !rel(p).includes('/_tests/')),
  ...arquivos(resolve(repo, 'supabase', 'functions'), (p) => codigo(p) && !/\.test\.ts$/.test(p))
];

// Arquivo + os módulos locais que ele importa, em cadeia (até 3 níveis): o padrão pode estar numa constante de
// outro módulo (ex.: assinatura-fiscal-ciclo → ./core.ts → ../assinatura-fiscal/core.ts).
function comImports(p, nivel = 0, vistos = new Set()) {
  if (vistos.has(p)) return '';
  vistos.add(p);
  let texto;
  try { texto = readFileSync(p, 'utf8'); } catch { return ''; }
  if (nivel >= 3) return texto;
  const vizinhos = [...texto.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => {
    const alvo = resolve(dirname(p), m[1]);
    const ts = alvo.replace(/\.js$/, '.ts');
    return comImports(ts !== alvo && !vistos.has(ts) ? ts : alvo, nivel + 1, vistos) || comImports(alvo, nivel + 1, vistos);
  });
  return [texto, ...vizinhos].join('\n');
}

test('dublês só na demo', async () => {
  // 1. Ninguém fora de tools/fiscal-demo/ importa os dublês nem a demo. A exceção são os testes desta pasta, que
  //    testam a própria demo (este arquivo) ou só lançam o comando (e2e-demo.mjs).
  const todos = arquivos(repo, (p) => /\.(m?js|cjs|ts|tsx|html)$/.test(p) && !rel(p).startsWith('tools/fiscal-demo/') && !rel(p).startsWith('tests/agente-fiscal-site/'));
  const importa = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bsrc\s*=\s*)['"][^'"]*(?:fiscal-demo|dubles\/)/;
  const culpados = todos.filter((p) => importa.test(readFileSync(p, 'utf8'))).map(rel);
  assert.deepEqual(culpados, [], 'importam a demo ou os dublês');

  // 2. Código de produção sem endereço de dublê.
  for (const p of producao()) {
    const texto = readFileSync(p, 'utf8');
    assert.doesNotMatch(texto, /(localhost|127\.0\.0\.1|host\.docker\.internal):300[2-6]\b/, `${rel(p)} aponta para um dublê`);
  }

  // 3. config.js de produção: projeto de produção, nada local, Pagar.me no padrão oficial do nofiscal.js.
  const ctx = { window: {} };
  vm.runInNewContext(ler('agentes/fiscal/config.js'), ctx);
  const cfg = ctx.window.NOFISCAL_CONFIG;
  assert.deepEqual(Object.keys(cfg).sort(), ['anonKey', 'apiBase', 'funcoesUrl', 'supabaseUrl', 'whatsappAgente']);
  assert.equal(cfg.supabaseUrl, 'https://sdeowbqmwkwseyktyemn.supabase.co');
  assert.equal(cfg.funcoesUrl, 'https://sdeowbqmwkwseyktyemn.supabase.co/functions/v1');
  assert.equal(cfg.apiBase, '/agentes/fiscal/api');
  assert.equal(JSON.parse(Buffer.from(cfg.anonKey.split('.')[1], 'base64url')).role, 'anon', 'só a chave anon (pública)');
  assert.doesNotMatch(ler('agentes/fiscal/config.js'), /localhost|127\.0\.0\.1|pagarmeApiUrl/);
  assert.match(ler('agentes/fiscal/nofiscal.js'), /CFG\.pagarmeApiUrl \|\| 'https:\/\/api\.pagar\.me\/core\/v5'/);

  // 4. As 5 variáveis são lidas pelo código de produção e, onde são lidas, o padrão é a URL oficial.
  const leitura = (v) => new RegExp(`(Deno\\.env\\.get\\(\\s*['"]${v}['"]|process\\.env\\.${v}\\b|process\\.env\\[['"]${v}['"]\\]|\\benv\\.${v}\\b|\\benv\\[['"]${v}['"]\\]|\\w\\(\\s*['"]${v}['"]\\s*\\))`); // o último: qualquer leitura por nome, como env('X') ou variavel('X')
  for (const [v, oficial] of Object.entries(OFICIAIS)) {
    const leem = producao().filter((p) => leitura(v).test(readFileSync(p, 'utf8')));
    assert.ok(leem.length > 0, `${v} é lida em algum lugar do código de produção`);
    for (const p of leem) assert.ok(comImports(p).includes(oficial), `${rel(p)} lê ${v} e o padrão tem de ser ${oficial}`);
  }

  // 5. Só a demonstração aponta essas variáveis para os dublês.
  const demo = await import(pathToFileURL(resolve(repo, 'tools/fiscal-demo/demo.mjs')).href);
  const s = { cron: 'c', salTeste: 's', salAcesso: 'a', metaSegredo: 'm', metaVerificacao: 'v', webhookPagarme: 'w' };
  const fn = demo.variaveisDasFuncoes(s);
  for (const v of ['PAGARME_ASSINATURA_API_URL', 'RESEND_API_URL', 'CNPJ_API_URL']) assert.match(fn[v], /^http:\/\/host\.docker\.internal:300[2-6]/, v);
  const ap = demo.variaveisDoApp(s, 'anon');
  for (const v of ['WHATSAPP_GRAPH_URL', 'ANTHROPIC_BASE_URL', 'RESEND_API_URL', 'CNPJ_API_URL']) assert.match(ap[v], /^http:\/\/127\.0\.0\.1:300[2-6]/, v);
  assert.match(ler('tools/fiscal-demo/.gitignore'), /^funcoes\.local\.vars$/m);
  assert.match(ler('package.json'), /"fiscal:demo":\s*"node tools\/fiscal-demo\/demo\.mjs"/);
});

test('servidores da demo: trailingSlash, proxy da API e link do WhatsApp', async () => {
  const { iniciarSite, trocarWaMe } = await import(pathToFileURL(resolve(repo, 'tools/fiscal-demo/site.mjs')).href);
  const vistos = [];
  const api = createServer((req, res) => {
    vistos.push(`${req.method} ${req.url}`);
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ codigo: '111222', whatsapp_url: 'https://wa.me/5511900000000?text=ATIVAR%20111222', expira_em: 'x' }));
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const porta = 39000 + Math.floor(Math.random() * 500);
  const site = await iniciarSite({ porta, apiUrl: `http://127.0.0.1:${api.address().port}`, supabaseUrl: `http://127.0.0.1:${api.address().port}`, configJs: 'window.NOFISCAL_CONFIG={local:true}', metaUrl: 'http://localhost:3004', urls: {} });
  try {
    const base = `http://127.0.0.1:${porta}`;
    const semBarra = await fetch(base + '/agentes/fiscal/comecar?plano=pro', { redirect: 'manual' });
    assert.equal(semBarra.status, 308);
    assert.equal(semBarra.headers.get('location'), '/agentes/fiscal/comecar/?plano=pro');
    assert.equal((await fetch(base + '/agentes/fiscal/comecar/')).status, 200);
    assert.equal(await (await fetch(base + '/agentes/fiscal/config.js')).text(), 'window.NOFISCAL_CONFIG={local:true}');
    const r = await fetch(base + '/agentes/fiscal/api/v1/onboarding/ativacao/', { method: 'POST', body: '{}' });
    assert.equal(r.status, 201);
    assert.deepEqual(vistos, ['POST /api/v1/onboarding/ativacao'], 'proxy sem a barra final, como o rewrite');
    assert.equal((await r.json()).whatsapp_url, 'http://localhost:3004/conversa?numero=5511900000000&text=ATIVAR%20111222');
    assert.equal((await fetch(base + '/tools/fiscal-demo/funcoes.local.vars')).status, 404, 'as variáveis locais não são servidas');
    assert.equal(JSON.parse(trocarWaMe('{"whatsapp_url":"https://exemplo.com/x"}', 'http://m')).whatsapp_url, 'https://exemplo.com/x');
  } finally {
    await new Promise((r) => site.close(r));
    await new Promise((r) => api.close(r));
  }
});

test('o dublê da Meta assina como a Meta', async () => {
  const { assinar, notificacao } = await import(pathToFileURL(resolve(repo, 'tools/fiscal-demo/dubles/meta.mjs')).href);
  const corpo = Buffer.from(JSON.stringify(notificacao({ de: '+5511987654321', texto: 'ATIVAR 123456', phoneNumberId: '1', numeroAgente: '55119' })));
  assert.equal(assinar(corpo, 'segredo'), 'sha256=' + createHmac('sha256', 'segredo').update(corpo).digest('hex'));
  const n = JSON.parse(corpo);
  const m = n.entry[0].changes[0].value.messages[0];
  assert.equal(n.object, 'whatsapp_business_account');
  assert.deepEqual([m.from, m.type, m.text.body], ['5511987654321', 'text', 'ATIVAR 123456']);
});

test('o dublê da IA segue o esquema pedido', async () => {
  const { interpretar, deEsquema, PDF_FIXO } = await import(pathToFileURL(resolve(repo, 'tools/fiscal-demo/dubles/ia.mjs')).href);
  const p = interpretar('nota pra Prontia Saúde, 10 reais');
  assert.equal(p.tomador, 'Prontia Saúde');
  assert.equal(p.valor, '10.00');
  assert.equal(p.intencao, 'emitir');
  const esquema = { type: 'object', properties: { tomador: { type: 'string' }, valor: { type: ['string', 'null'] }, intencao: { enum: ['emitir', 'cancelar', 'outro'] }, extra: { type: ['string', 'null'] } } };
  assert.deepEqual(deEsquema(esquema, p), { tomador: 'Prontia Saúde', valor: '10.00', intencao: 'emitir', extra: null });
  assert.equal(deEsquema({ type: 'object', properties: { tomador_documento: { type: 'string' } } }, PDF_FIXO).tomador_documento, '11444777000161');
});
