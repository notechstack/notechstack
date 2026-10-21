// Integração local das rotas /cliente/* da marketing-hub no runtime Deno real,
// com Auth, Vault e RLS locais. Credenciais de app são fixtures (nenhuma real).
//
// Pré-requisitos: `supabase start` e, em outro terminal,
//   supabase functions serve marketing-hub --env-file <arquivo com as variáveis abaixo>
//   MARKETING_OAUTH_STATE_SECRET=<fixture com 32+ caracteres>
//   META_APP_ID=424242  META_APP_SECRET=<fixture, igual a FIXTURE_META_SECRET abaixo>  META_LOGIN_CONFIG_ID=cfg-local
//   GOOGLE_OAUTH_CLIENT_ID=fixture-client  GOOGLE_OAUTH_CLIENT_SECRET=fixture
//   MARKETING_HUB_PUBLIC_URL=<API_URL>/functions/v1/marketing-hub
//   AUDITOR_VOLTA_URL=http://localhost/auditor/{client_id}/conexoes
// Uso: node supabase/tests/hub_marketing_clientes_edge.mjs
// SUPABASE_DB_CONTAINER troca o container do banco (padrão: o do projeto);
// FIXTURE_META_SECRET troca o app secret de fixture (padrão: fixture-local-meta-secret).
// Única chamada externa: a leitura de contas com um token falso, que a Meta recusa (prova o "expirado").

import { execFileSync } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'

const status = execFileSync('supabase', ['status', '-o', 'env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const envLocal = Object.fromEntries(status.split(/\r?\n/).map((l) => l.match(/^([A-Z_]+)="(.*)"$/)).filter(Boolean).map((m) => [m[1], m[2]]))
const API = envLocal.API_URL
const ANON = envLocal.ANON_KEY
const SERVICE = envLocal.SERVICE_ROLE_KEY
if (!API || !ANON || !SERVICE) throw new Error('Supabase local indisponível')
const FN = `${API}/functions/v1/marketing-hub`
const DB = process.env.SUPABASE_DB_CONTAINER ?? 'supabase_db_sdeowbqmwkwseyktyemn'
const META_SECRET = process.env.FIXTURE_META_SECRET ?? 'fixture-local-meta-secret'

const passes = []
function ok(cond, rotulo, detalhe) {
  if (!cond) throw new Error(`FALHOU: ${rotulo}${detalhe ? ` — ${JSON.stringify(detalhe).slice(0, 400)}` : ''}`)
  passes.push(rotulo)
  console.log(`PASS ${rotulo}`)
}

async function http(metodo, url, { token, apikey = ANON, corpo, form, extra = {} } = {}) {
  const r = await fetch(url, {
    method: metodo,
    redirect: 'manual',
    headers: {
      apikey, ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(corpo ? { 'content-type': 'application/json' } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...extra,
    },
    body: corpo ? JSON.stringify(corpo) : form ? new URLSearchParams(form).toString() : undefined,
  })
  const texto = await r.text()
  let body = texto
  try { body = texto ? JSON.parse(texto) : null } catch { /* texto puro */ }
  return { status: r.status, body, headers: r.headers }
}

const psql = (sql) => execFileSync('docker', ['exec', '-i', DB, 'psql', '-U', 'postgres', '-d', 'postgres', '-Atc', sql], { encoding: 'utf8' }).trim()

const sufixo = randomUUID().slice(0, 8)
const senha = `Cli-${randomUUID()}!aA1`
const CLI_A = randomUUID()
const CLI_B = randomUUID()
const usuarios = []

async function criarUsuario(nome, papel) {
  const email = `auditor-${nome}-${sufixo}@example.test`
  const r = await http('POST', `${API}/auth/v1/admin/users`, { token: SERVICE, apikey: SERVICE, corpo: { email, password: senha, email_confirm: true, app_metadata: { role: papel } } })
  if (r.status >= 300) throw new Error(`usuário ${nome}: ${r.status}`)
  usuarios.push(r.body.id)
  const login = await http('POST', `${API}/auth/v1/token?grant_type=password`, { corpo: { email, password: senha } })
  if (login.status !== 200) throw new Error(`login ${nome}: ${login.status}`)
  return { id: r.body.id, token: login.body.access_token }
}

const voltaDe = (r) => new URL(r.headers.get('location'))
const stateDe = async (sessao, provedor, clientId) => {
  const r = await http('POST', `${FN}/cliente/${clientId}/${provedor}/conectar`, { token: sessao })
  ok(r.status === 200 && r.body.url.startsWith(`${FN}/cliente/${provedor}/ir?state=v1.`), `conectar ${provedor} devolve /ir`, r)
  return new URL(r.body.url).searchParams.get('state')
}
const ir = (state, provedor) => http('GET', `${FN}/cliente/${provedor}/ir?state=${encodeURIComponent(state)}`)

try {
  psql(`insert into public.clients (id, name, slug, origem) values ('${CLI_A}', 'Auditor A ${sufixo}', 'auditor-a-${sufixo}', 'auditor'), ('${CLI_B}', 'Auditor B ${sufixo}', 'auditor-b-${sufixo}', 'auditor')`)
  const a = await criarUsuario('a', 'AUDITOR_CLIENT')
  const b = await criarUsuario('b', 'AUDITOR_CLIENT')
  const dot = await criarUsuario('dot', 'MARKETING_AGENT')
  const adm = await criarUsuario('admin', 'NO_ADMIN')
  psql(`insert into public.memberships (user_id, client_id, role) values ('${a.id}', '${CLI_A}', 'AUDITOR'), ('${b.id}', '${CLI_B}', 'AUDITOR')`)

  // Quem pode iniciar.
  ok((await http('POST', `${FN}/cliente/${CLI_A}/meta/conectar`)).status === 401, 'E1 sem sessão → 401')
  ok((await http('POST', `${FN}/cliente/${CLI_A}/meta/conectar`, { token: b.token })).status === 403, 'E1 cliente B no negócio A → 403')
  ok((await http('POST', `${FN}/cliente/${CLI_B}/meta/conectar`, { token: a.token, corpo: { client_id: CLI_A } })).status === 403, 'E1 client_id do corpo é ignorado')
  ok((await http('POST', `${FN}/cliente/${CLI_A}/meta/conectar`, { token: dot.token })).status === 403, 'E1 dot → 403')
  ok((await http('POST', `${FN}/cliente/${CLI_A}/meta/conectar`, { token: adm.token })).status === 403, 'E1 NO_ADMIN (sem aal2, sem concessão) → 403')
  ok((await http('GET', `${FN}/overview?periodo=7d`, { token: a.token })).status === 403, 'E1 cliente segue sem acesso ao /overview do admin')

  // Meta: ida.
  const stateMeta = await stateDe(a.token, 'meta', CLI_A)
  const viaIr = await ir(stateMeta, 'meta')
  const destino = new URL(viaIr.headers.get('location') ?? 'http://x')
  const cookie = (viaIr.headers.get('set-cookie') ?? '').split(';')[0]
  ok(viaIr.status === 303 && destino.host === 'www.facebook.com' && destino.pathname.endsWith('/dialog/oauth'), 'E2 /ir manda ao diálogo da Meta', { status: viaIr.status })
  ok(destino.searchParams.get('client_id') === '424242' && destino.searchParams.get('config_id') === 'cfg-local', 'E2 app e config_id do Login for Business')
  ok(destino.searchParams.get('code_challenge_method') === 'S256' && /^[A-Za-z0-9_-]{43}$/.test(destino.searchParams.get('code_challenge') ?? ''), 'E2 PKCE S256')
  ok(destino.searchParams.get('redirect_uri') === `${FN}/cliente/meta/callback`, 'E2 redirect_uri da função')
  ok(/^__Host-no_oauth_meta=[a-f0-9]{64}$/.test(cookie) && /HttpOnly/.test(viaIr.headers.get('set-cookie')), 'E2 cookie HttpOnly preso ao navegador')
  const nonce = cookie.split('=')[1]
  ok(psql(`select count(*) from public.marketing_oauth_nonces where nonce = '${nonce}'`) === '1', 'E2 nonce registrado no banco')

  // Meta: volta.
  const semCookie = await http('GET', `${FN}/cliente/meta/callback?code=x&state=${encodeURIComponent(stateMeta)}`)
  ok(voltaDe(semCookie).searchParams.get('motivo') === 'navegador_diferente', 'E3 volta sem cookie é recusada', voltaDe(semCookie).href)
  ok(psql(`select count(*) from public.marketing_oauth_nonces where nonce = '${nonce}'`) === '1', 'E3 e não queima o nonce')
  const negou = await http('GET', `${FN}/cliente/meta/callback?error=access_denied&error_reason=user_denied&state=${encodeURIComponent(stateMeta)}`, { extra: { cookie } })
  ok(voltaDe(negou).href.startsWith(`http://localhost/auditor/${CLI_A}/conexoes?`) && voltaDe(negou).searchParams.get('motivo') === 'access_denied', 'E3 usuário negou → volta às conexões do negócio com motivo', voltaDe(negou).href)
  ok(psql(`select count(*) from public.marketing_oauth_nonces where nonce = '${nonce}'`) === '0', 'E3 nonce consumido')
  const replay = await http('GET', `${FN}/cliente/meta/callback?code=x&state=${encodeURIComponent(stateMeta)}`, { extra: { cookie } })
  ok(voltaDe(replay).searchParams.get('motivo') === 'state_reusado', 'E3 replay do state → state_reusado')
  const adulterado = await http('GET', `${FN}/cliente/meta/callback?code=x&state=${encodeURIComponent(stateMeta.slice(0, -3) + 'AAA')}`, { extra: { cookie } })
  ok(voltaDe(adulterado).searchParams.get('motivo') === 'state_invalido', 'E3 state adulterado → state_invalido')

  // Google: ida.
  const stateGoogle = await stateDe(a.token, 'google', CLI_A)
  const g = await ir(stateGoogle, 'google')
  const gDestino = new URL(g.headers.get('location') ?? 'http://x')
  ok(gDestino.host === 'accounts.google.com' && gDestino.searchParams.get('access_type') === 'offline' && gDestino.searchParams.get('prompt') === 'consent', 'E4 /ir manda ao consentimento Google offline')
  ok(gDestino.searchParams.get('scope').split(' ').length === 3 && gDestino.searchParams.get('code_challenge_method') === 'S256', 'E4 três escopos e PKCE')

  // Vault + RPCs pela função (conexão gravada como a função gravaria).
  psql(`select public.marketing_cliente_conexao_salvar('${CLI_A}', 'meta', 'fixture-local-meta-token', array['ads_read'], now() + interval '60 days', 'fb-local-${sufixo}', '${a.id}')`)
  const conexoes = await http('GET', `${FN}/cliente/${CLI_A}/conexoes`, { token: a.token })
  ok(conexoes.status === 200 && conexoes.body.conexoes.meta.estado === 'conectado' && conexoes.body.conexoes.google.estado === 'desconectado', 'E5 /conexoes do negócio A (lido com o JWT do usuário)', conexoes.body)
  ok(!JSON.stringify(conexoes.body).includes('fixture-local-meta-token'), 'E5 token nunca sai na resposta')
  ok((await http('GET', `${FN}/cliente/${CLI_A}/conexoes`, { token: b.token })).status === 403, 'E5 cliente B não lê conexões de A')

  // RLS direto pelo PostgREST com a sessão do cliente.
  const restA = await http('GET', `${API}/rest/v1/marketing_cliente_conexoes?select=client_id,provedor,estado`, { token: a.token })
  const restB = await http('GET', `${API}/rest/v1/marketing_cliente_conexoes?select=client_id,provedor,estado`, { token: b.token })
  const restDot = await http('GET', `${API}/rest/v1/marketing_cliente_conexoes?select=client_id`, { token: dot.token })
  ok(restA.status === 200 && restA.body.length === 1 && restA.body[0].client_id === CLI_A, 'E6 PostgREST: A lê a própria conexão', restA.body)
  ok(restB.status === 200 && restB.body.length === 0, 'E6 PostgREST: B não lê a de A', restB.body)
  ok(restDot.status === 200 && restDot.body.length === 0, 'E6 PostgREST: dot não lê nada', restDot.body)
  ok((await http('GET', `${API}/rest/v1/marketing_cliente_conexoes?select=vault_secret_id`, { token: a.token })).status >= 400, 'E6 PostgREST: vault_secret_id negado')
  ok((await http('GET', `${API}/rest/v1/marketing_cliente_eventos?select=id`, { token: a.token })).status >= 400, 'E6 PostgREST: eventos negados ao navegador')
  ok((await http('POST', `${API}/rest/v1/rpc/marketing_cliente_token_ler`, { token: a.token, corpo: { p_client_id: CLI_A, p_provedor: 'meta' } })).status >= 400, 'E6 PostgREST: RPC de token negada ao cliente')

  // Token recusado pela Meta → conexão "expirado" (lê pelo Vault, marca pela RPC).
  const contas = await http('GET', `${FN}/cliente/${CLI_A}/meta/contas`, { token: a.token })
  const depois = psql(`select estado || ':' || coalesce(ultimo_erro, '') from public.marketing_cliente_conexoes where client_id = '${CLI_A}' and provedor = 'meta' and estado <> 'desconectado'`)
  if (depois.startsWith('expirado')) ok(contas.status >= 400 && depois === 'expirado:meta_190', 'E7 token falso recusado pela Meta marca expirado com o código meta_190', depois)
  else console.log(`AVISO E7: sem rede até a Meta (status ${contas.status}); marcação de expirado não verificada aqui (coberta no Vitest).`)

  // Deauthorize da Meta com signed_request assinado pelo app secret de fixture.
  psql(`update public.marketing_cliente_conexoes set estado = 'conectado', ultimo_erro = null where client_id = '${CLI_A}' and provedor = 'meta' and estado <> 'desconectado'`)
  const corpoSr = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: 'x', issued_at: 1 })).toString('base64url')
  const srRuim = `${createHmac('sha256', 'outro-segredo').update(corpoSr).digest('base64url')}.${corpoSr}`
  ok((await http('POST', `${FN}/cliente/meta/desautorizar`, { form: { signed_request: srRuim } })).status === 400, 'E8 deauthorize com assinatura errada → 400')
  ok(psql(`select estado from public.marketing_cliente_conexoes where client_id = '${CLI_A}' and provedor = 'meta' and estado <> 'desconectado'`) === 'conectado', 'E8 e nada muda')

  // Desconectar: Vault limpo, linha como histórico.
  ok((await http('DELETE', `${FN}/cliente/${CLI_A}/meta`, { token: b.token })).status === 403, 'E9 B não desconecta A')
  const desc = await http('DELETE', `${FN}/cliente/${CLI_A}/meta`, { token: a.token })
  ok(desc.status === 200 && desc.body.estado === 'desconectado' && desc.body.havia_conexao === true, 'E9 A desconecta a própria conexão', desc.body)
  ok(psql(`select count(*) from vault.secrets where name = 'marketing_cliente:${CLI_A}:meta'`) === '0', 'E9 segredo apagado do Vault')
  ok(psql(`select count(*) from public.marketing_cliente_eventos where client_id = '${CLI_A}' and acao = 'desconectou'`) === '1', 'E9 trilha de desconexão')

  // Deauthorize válido (o user_id numérico vem da Meta).
  psql(`select public.marketing_cliente_conexao_salvar('${CLI_A}', 'meta', 'fixture-local-meta-token-2', array['ads_read'], null, '90017${sufixo.replace(/\D/g, '')}', '${a.id}')`)
  const uid = psql(`select usuario_externo from public.marketing_cliente_conexoes where client_id = '${CLI_A}' and provedor = 'meta' and estado = 'conectado'`)
  const corpoOk = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: uid, issued_at: 1 })).toString('base64url')
  const srOk = `${createHmac('sha256', META_SECRET).update(corpoOk).digest('base64url')}.${corpoOk}`
  ok((await http('POST', `${FN}/cliente/meta/desautorizar`, { form: { signed_request: srOk } })).status === 200, 'E10 deauthorize assinado → 200')
  ok(psql(`select estado from public.marketing_cliente_conexoes where client_id = '${CLI_A}' and provedor = 'meta' and estado <> 'desconectado'`) === 'revogado', 'E10 conexão revogada')
  ok(psql(`select count(*) from vault.secrets where name = 'marketing_cliente:${CLI_A}:meta'`) === '0', 'E10 segredo apagado do Vault')

  console.log(`\n${passes.length} verificações passaram.`)
} finally {
  psql(`delete from public.marketing_cliente_conexoes where client_id in ('${CLI_A}', '${CLI_B}')`)
  psql(`delete from public.marketing_cliente_eventos where client_id in ('${CLI_A}', '${CLI_B}')`)
  psql(`delete from public.memberships where client_id in ('${CLI_A}', '${CLI_B}')`)
  psql(`delete from public.clients where id in ('${CLI_A}', '${CLI_B}')`)
  for (const id of usuarios) await http('DELETE', `${API}/auth/v1/admin/users/${id}`, { token: SERVICE, apikey: SERVICE })
}
