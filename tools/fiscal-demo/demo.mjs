// npm run fiscal:demo (critérios 54–56 da tarefa agente-fiscal-v2): com o Supabase local no ar (API 54321, banco
// 54322), sobe o site (:3000), a API do app (:3001), as edge functions (`supabase functions serve` com variáveis
// locais geradas aqui) e os dublês do Pagar.me (:3002), da Resend (:3003), da Meta (:3004), da IA (:3005) e da
// BrasilAPI (:3006). Os dublês só existem aqui (Landing: "Dublês só na demonstração").
//   --sem-funcoes   não sobe `supabase functions serve` (quando já está rodando em outro terminal)
import { spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { iniciarSite } from './site.mjs';
import { iniciarPagarme } from './dubles/pagarme.mjs';
import { iniciarResend } from './dubles/resend.mjs';
import { iniciarMeta } from './dubles/meta.mjs';
import { iniciarIa } from './dubles/ia.mjs';
import { iniciarBrasilApi } from './dubles/brasilapi.mjs';

const demo = dirname(fileURLToPath(import.meta.url));
const raiz = resolve(demo, '..', '..');
const app = resolve(raiz, 'app');
const windows = process.platform === 'win32';
const args = new Set(process.argv.slice(2));

export const PORTAS = { site: 3000, api: 3001, pagarme: 3002, resend: 3003, meta: 3004, ia: 3005, brasilapi: 3006 };
export const ARQUIVO_VARS = resolve(demo, 'funcoes.local.vars');
const BANCO = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const SUPABASE = 'http://127.0.0.1:54321';
const NUMERO_AGENTE = '5511900000000';
const PHONE_NUMBER_ID = '100000000000001';
// Código de e-mail fixo da demo: fiscal-acesso só o aceita com FISCAL_SITE_URL em localhost.
export const CODIGO_FIXO_DEMO = '123456';

const rand = (n = 24) => randomBytes(n).toString('hex');
const falhar = (msg) => { console.error(`\n[demo] ${msg}\n`); process.exit(1); };

function portaAberta(porta, host = '127.0.0.1') {
  return new Promise((ok) => {
    const s = connect({ port: porta, host }, () => { s.end(); ok(true); });
    s.on('error', () => ok(false));
    s.setTimeout(1500, () => { s.destroy(); ok(false); });
  });
}

function instalarSeFaltar(pasta, marcador) {
  if (existsSync(resolve(pasta, 'node_modules', marcador))) return;
  console.log(`[demo] instalando dependências em ${pasta} …`);
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: pasta, stdio: 'inherit', shell: windows });
  if (r.status !== 0) falhar(`npm install falhou em ${pasta}`);
}

/* Chave anon do Supabase local (pública). O resto da saída do `supabase status` nunca é guardado nem impresso. */
function anonLocal() {
  const r = spawnSync('supabase', ['status', '-o', 'json'], { cwd: raiz, encoding: 'utf8', shell: windows });
  const ini = (r.stdout || '').indexOf('{');
  if (r.status !== 0 || ini < 0) falhar('não consegui ler o `supabase status`. O Supabase local está no ar? (supabase start)');
  let status;
  try { status = JSON.parse(r.stdout.slice(ini)); } catch { falhar('saída do `supabase status -o json` ilegível'); }
  const anon = status.ANON_KEY || status.anon_key || status.PUBLISHABLE_KEY;
  if (!anon) falhar('o `supabase status` não trouxe a chave anon');
  return anon;
}

export function variaveisDasFuncoes(s) {
  const host = 'http://host.docker.internal';
  return {
    PAGARME_ASSINATURA_API_URL: `${host}:${PORTAS.pagarme}/core/v5`,
    PAGARME_ASSINATURA_SECRET_KEY: 'sk_test_demo_local',
    PAGARME_ASSINATURA_PUBLIC_KEY: 'pk_test_demo_local',
    PAGARME_ASSINATURA_AMBIENTE: 'sandbox',
    PAGARME_PLANO_FISCAL_INICIAL_ID: 'plan_demo_inicial',
    PAGARME_PLANO_FISCAL_PRO_ID: 'plan_demo_pro',
    PAGARME_PLANO_FISCAL_INICIAL_SEM_TESTE_ID: 'plan_demo_inicial_sem_teste',
    PAGARME_PLANO_FISCAL_PRO_SEM_TESTE_ID: 'plan_demo_pro_sem_teste',
    PAGARME_FISCAL_WEBHOOK_USER: 'demo',
    PAGARME_FISCAL_WEBHOOK_PASS: s.webhookPagarme,
    FISCAL_VENDA_ABERTA: 'sim',
    FISCAL_TRIAL_SALT: s.salTeste,
    FISCAL_ACESSO_SALT: s.salAcesso,
    RESEND_API_KEY: 're_demo_local',
    RESEND_API_URL: `${host}:${PORTAS.resend}`,
    FISCAL_EMAIL_FROM: 'nó.fiscal <notas@demo.local>',
    FISCAL_SITE_URL: `http://localhost:${PORTAS.site}`,
    CNPJ_API_URL: `${host}:${PORTAS.brasilapi}`,
    FISCAL_AMBIENTE_PADRAO: 'producao_restrita',
    FISCAL_ALERTA_EMAIL: 'lucca@demo.local',
    FISCAL_CODIGO_VALIDADE_S: '3600',
    FISCAL_CODIGO_FIXO_DEMO: CODIGO_FIXO_DEMO
  };
}

export function variaveisDoApp(s, anon) {
  const local = (porta) => `http://127.0.0.1:${porta}`;
  return {
    NOFISCAL_DATABASE_URL: `${BANCO}?options=-c%20role%3Dnofiscal_service`,
    NOFISCAL_ONBOARDING_DATABASE_URL: `${BANCO}?options=-c%20role%3Dnofiscal_onboarding`,
    SUPABASE_URL: SUPABASE,
    SUPABASE_ANON_KEY: anon,
    WHATSAPP_ACCESS_TOKEN: 'demo-token-local',
    WHATSAPP_PHONE_NUMBER_ID: PHONE_NUMBER_ID,
    WHATSAPP_APP_SECRET: s.metaSegredo,
    WHATSAPP_VERIFY_TOKEN: s.metaVerificacao,
    WHATSAPP_GRAPH_URL: local(PORTAS.meta),
    WHATSAPP_NUMERO_AGENTE: NUMERO_AGENTE,
    WHATSAPP_MODELO_BOAS_VINDAS: 'nofiscal_boas_vindas_demo',
    WHATSAPP_MODELO_RESUMO: 'nofiscal_resumo_demo',
    RESEND_API_KEY: 're_demo_local',
    RESEND_API_URL: local(PORTAS.resend),
    AGENTE_FISCAL_EMAIL_FROM: 'nó.fiscal <notas@demo.local>',
    ANTHROPIC_API_KEY: 'sk-ant-demo-local',
    ANTHROPIC_BASE_URL: local(PORTAS.ia),
    AGENTE_FISCAL_IA_MODELO: 'claude-haiku-4-5-20251001',
    CNPJ_API_URL: local(PORTAS.brasilapi),
    CRON_SECRET: s.cron,
    FISCAL_TRIAL_SALT: s.salTeste,
    FISCAL_ALERTA_EMAIL: 'lucca@demo.local',
    AGENTE_FISCAL_SITE_URL: `http://localhost:${PORTAS.site}/agentes/fiscal/`,
    DEMO_API_PORTA: String(PORTAS.api)
  };
}

function escreverVars(vars) {
  const linhas = ['# Gerado por tools/fiscal-demo/demo.mjs a cada subida (no .gitignore). Só valores locais e aleatórios da demonstração.']
    .concat(Object.entries(vars).map(([k, v]) => `${k}=${v}`));
  writeFileSync(ARQUIVO_VARS, linhas.join('\n') + '\n');
}

const filhos = [];
function lancar(nome, comando, argumentos, opcoes) {
  const f = spawn(comando, argumentos, { stdio: 'inherit', ...opcoes });
  f.on('exit', (codigo) => { if (!encerrando) console.error(`[demo] ${nome} saiu (código ${codigo}).`); });
  filhos.push(f);
  return f;
}
let encerrando = false;
function encerrar() {
  if (encerrando) return;
  encerrando = true;
  for (const f of filhos) {
    if (f.exitCode !== null) continue;
    if (windows) spawnSync('taskkill', ['/pid', String(f.pid), '/T', '/F'], { stdio: 'ignore' });
    else f.kill('SIGTERM');
  }
  process.exit(0);
}

async function esperar(nome, teste, segundos) {
  const fim = Date.now() + segundos * 1000;
  while (Date.now() < fim) {
    if (await teste().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error(`[demo] ${nome} não respondeu em ${segundos} s.`);
  return false;
}

async function donoPadrao() {
  const pg = createRequire(resolve(app, 'package.json'))('pg');
  const c = new pg.Client({ connectionString: BANCO });
  await c.connect();
  try {
    const { rows } = await c.query("select phone_e164 from nofiscal.fiscal_phones where role = 'owner' order by created_at desc limit 1");
    return rows[0] ? rows[0].phone_e164 : '';
  } finally { await c.end(); }
}

/* Cupons da demonstração, só no banco local (migração 20261025090000). NOTESTE100 é cortesia: pula o pagamento. */
export const CUPONS_DEMO = [
  { codigo: 'NOTESTE100', tipo: 'percentual', valor: 100, ciclos: null, planos: null, max_usos: 1000, descricao: 'Demonstração: assinatura sem cobrança' },
  { codigo: 'METADE3', tipo: 'percentual', valor: 50, ciclos: 3, planos: null, max_usos: null, descricao: 'Demonstração: 50% nos 3 primeiros meses' },
  { codigo: 'MENOS20', tipo: 'valor', valor: 2000, ciclos: null, planos: null, max_usos: null, descricao: 'Demonstração: R$ 20 a menos por mês' },
  { codigo: 'SOPRO20', tipo: 'percentual', valor: 20, ciclos: null, planos: ['pro'], max_usos: null, descricao: 'Demonstração: 20% só no Pro' }
];

async function cuponsDaDemo() {
  const pg = createRequire(resolve(app, 'package.json'))('pg');
  const c = new pg.Client({ connectionString: BANCO });
  await c.connect();
  try {
    for (const k of CUPONS_DEMO) {
      await c.query(
        `insert into nofiscal.fiscal_cupons (codigo, tipo, valor, ciclos, planos, max_usos, descricao)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (codigo) do update set tipo = excluded.tipo, valor = excluded.valor, ciclos = excluded.ciclos,
           planos = excluded.planos, max_usos = excluded.max_usos, descricao = excluded.descricao, ativo = true, valido_ate = null`,
        [k.codigo, k.tipo, k.valor, k.ciclos, k.planos, k.max_usos, k.descricao],
      );
    }
  } finally { await c.end(); }
}

async function principal() {
  if (!(await portaAberta(54321)) || !(await portaAberta(54322))) falhar('o Supabase local não está no ar (API 54321, banco 54322). Rode `supabase start` na raiz do repositório.');
  for (const [nome, porta] of Object.entries(PORTAS)) if (await portaAberta(porta)) falhar(`a porta ${porta} (${nome}) já está em uso. Feche a outra demonstração ou o servidor que está nela.`);
  instalarSeFaltar(app, 'pg');
  instalarSeFaltar(demo, 'tsx');
  await cuponsDaDemo();
  const anon = anonLocal();
  const s = { cron: rand(), salTeste: rand(), salAcesso: rand(), metaSegredo: rand(), metaVerificacao: rand(), webhookPagarme: rand(12) };
  escreverVars(variaveisDasFuncoes(s));

  const urls = { site: `http://localhost:${PORTAS.site}`, resend: `http://localhost:${PORTAS.resend}`, pagarme: `http://localhost:${PORTAS.pagarme}`, meta: `http://localhost:${PORTAS.meta}`, ia: `http://localhost:${PORTAS.ia}` };
  await iniciarPagarme({ porta: PORTAS.pagarme });
  await iniciarResend({ porta: PORTAS.resend });
  await iniciarIa({ porta: PORTAS.ia });
  await iniciarBrasilApi({ porta: PORTAS.brasilapi });
  await iniciarMeta({ porta: PORTAS.meta, webhookUrl: `http://127.0.0.1:${PORTAS.api}/api/whatsapp/webhook`, segredo: s.metaSegredo, phoneNumberId: PHONE_NUMBER_ID, numeroAgente: NUMERO_AGENTE, donoPadrao });
  const configJs = `/* config.js da demonstração local (tools/fiscal-demo), servido no lugar do de produção. */\nwindow.NOFISCAL_CONFIG = ${JSON.stringify({
    supabaseUrl: urls.site, anonKey: anon, funcoesUrl: `${urls.site}/functions/v1`, apiBase: '/agentes/fiscal/api', whatsappAgente: NUMERO_AGENTE, pagarmeApiUrl: `${urls.pagarme}/core/v5`, codigoFixoDemo: CODIGO_FIXO_DEMO
  }, null, 2)};\n`;
  await iniciarSite({ porta: PORTAS.site, apiUrl: `http://127.0.0.1:${PORTAS.api}`, supabaseUrl: SUPABASE, configJs, metaUrl: urls.meta, urls });

  lancar('API do app', process.execPath, ['--import', 'tsx', resolve(demo, 'api.mjs')], { cwd: demo, env: { ...process.env, ...variaveisDoApp(s, anon) } });
  if (!args.has('--sem-funcoes')) {
    lancar('edge functions', 'supabase', ['functions', 'serve', '--env-file', ARQUIVO_VARS, '--no-verify-jwt'], { cwd: raiz, shell: windows });
  }
  process.on('SIGINT', encerrar);
  process.on('SIGTERM', encerrar);

  await esperar('API do app', () => portaAberta(PORTAS.api), 60);
  const funcoesOk = await esperar('edge functions', async () => {
    const r = await fetch(`${SUPABASE}/functions/v1/assinatura-fiscal`, { method: 'GET' });
    return r.status < 500 || r.status === 501;
  }, 120);

  setInterval(() => {
    fetch(`http://127.0.0.1:${PORTAS.api}/api/internal/nfse-worker`, { method: 'POST', headers: { authorization: `Bearer ${s.cron}` } }).catch(() => {});
  }, 60_000).unref();

  console.log(`
[demo] pronto${funcoesOk ? '' : ' (as edge functions ainda não responderam; veja o log acima)'}:
  site ............ ${urls.site}/agentes/fiscal/   (painel: ${urls.site}/__demo/)
  cadastro ........ ${urls.site}/agentes/fiscal/comecar/?plano=pro
  minha conta ..... ${urls.site}/agentes/fiscal/conta/
  API do app ...... http://localhost:${PORTAS.api}/api/
  e-mails ......... ${urls.resend}   (o código de 6 dígitos aparece aqui; ou use ${CODIGO_FIXO_DEMO})
  WhatsApp ........ ${urls.meta}/conversa
  Pagar.me ........ ${urls.pagarme}   IA ... ${urls.ia}   BrasilAPI ... http://localhost:${PORTAS.brasilapi}
  cupons .......... ${CUPONS_DEMO.map((k) => k.codigo).join(', ')}   (NOTESTE100 pula o pagamento)
  CNPJs de teste .. começando com 777 (os demais consultam a BrasilAPI real)
Ctrl+C encerra tudo.`);
}

// Só como script (npm run fiscal:demo); importar o módulo (testes) não sobe nada.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  principal().catch((e) => { console.error('[demo] falhou:', e && e.message); encerrar(); });
}
