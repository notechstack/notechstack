// Integração local do auditor (Frente 3) no runtime Deno real: marketing-hub (rotas do auditor e
// /cliente/* da Frente 1) e auditor-acesso, com contas reais do Auth local. Não fala com Meta, Google,
// Resend nem Pagar.me (sem as chaves, esses caminhos devem falhar de forma controlada).
//
// Pré-requisitos: `supabase start` com as migrations até 20261021130000 e, em outro terminal,
// `supabase functions serve --env-file <arquivo com DIAG_IP_SALT e APP_URL de teste>`.
// Uso: node supabase/tests/auditor_edge.mjs   (AUDITOR_DB_CONTAINER = container do banco local)

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const status = execFileSync('supabase', ['status', '-o', 'env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const envLocal = Object.fromEntries(status.split(/\r?\n/).map((l) => l.match(/^([A-Z_]+)="(.*)"$/)).filter(Boolean).map((m) => [m[1], m[2]]))
const API = envLocal.API_URL
const ANON = envLocal.ANON_KEY
const SERVICE = envLocal.SERVICE_ROLE_KEY
if (!API || !ANON || !SERVICE) throw new Error('Supabase local indisponível')
const DB = process.env.AUDITOR_DB_CONTAINER ?? 'supabase_db_sdeowbqmwkwseyktyemn'
const HUB = `${API}/functions/v1/marketing-hub`

const passes = []
function ok(cond, rotulo, detalhe) {
  if (!cond) throw new Error(`FALHOU: ${rotulo}${detalhe ? ` — ${JSON.stringify(detalhe).slice(0, 500)}` : ''}`)
  passes.push(rotulo)
  console.log(`PASS ${rotulo}`)
}
const psql = (sql) => execFileSync('docker', ['exec', '-i', DB, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8' }).trim()

async function chamar(url, { metodo = 'GET', jwt, corpo, headers = {} } = {}) {
  const r = await fetch(url, {
    method: metodo,
    headers: { apikey: ANON, ...(jwt ? { authorization: `Bearer ${jwt}` } : {}), ...(corpo ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(corpo ? { body: JSON.stringify(corpo) } : {}),
  })
  const texto = await r.text()
  let json = null
  try { json = JSON.parse(texto) } catch { /* corpo vazio */ }
  return { status: r.status, json }
}

async function usuario(papel) {
  const email = `edge-${randomUUID().slice(0, 8)}@example.test`
  const senha = `Senha-${randomUUID()}`
  const criado = await chamar(`${API}/auth/v1/admin/users`, {
    metodo: 'POST', jwt: SERVICE, headers: { apikey: SERVICE },
    corpo: { email, password: senha, email_confirm: true, app_metadata: { role: papel } },
  })
  ok(criado.status === 200, `cria usuário ${papel}`, criado)
  const login = await chamar(`${API}/auth/v1/token?grant_type=password`, { metodo: 'POST', corpo: { email, password: senha } })
  ok(login.status === 200 && login.json?.access_token, `login ${papel}`, login.status)
  return { id: criado.json.id, email, jwt: login.json.access_token }
}

const segredo = psql("select decrypted_secret from vault.decrypted_secrets where name = 'MARKETING_CRON_SECRET'")
ok(/^[0-9a-f]{64}$/.test(segredo), 'segredo do cron no Vault local')

// 1 · processar: sem segredo 401; fila vazia → 200 vazio, sem erro (prova de "roda vazio").
ok((await chamar(`${HUB}/internal/auditor/processar`, { metodo: 'POST' })).status === 401, 'processar sem segredo → 401')
psql("delete from public.auditor_relatorios where estado = 'agendado'; delete from public.auditor_avisos where enviado_em is null;")
const vazio = await chamar(`${HUB}/internal/auditor/processar`, { metodo: 'POST', headers: { 'x-cron-secret': segredo } })
ok(vazio.status === 200 && JSON.stringify(vazio.json) === JSON.stringify({ relatorios: {}, avisos: 0 }), 'processar com fila vazia → 200 vazio', vazio)
ok(psql('select public.auditor_planejar_relatorios()') === '0', 'planejar sem assinantes → 0, sem erro')

// 2 · cliente: primeiro acesso pela RPC com o JWT dele; RLS e rota /cliente/* da Frente 1.
const cliente = await usuario('AUDITOR_CLIENT')
const eu = await chamar(`${API}/rest/v1/rpc/auditor_eu_iniciar`, { metodo: 'POST', jwt: cliente.jwt, corpo: { p_site_url: null } })
ok(eu.status === 200 && eu.json?.plano === 'gratis' && eu.json.negocios.length === 1, 'auditor_eu_iniciar cria conta grátis e negócio', eu)
const clientId = eu.json.negocios[0].client_id
const conexoes = await chamar(`${HUB}/cliente/${clientId}/conexoes`, { jwt: cliente.jwt })
ok(conexoes.status === 200 && conexoes.json?.conexoes?.meta?.estado === 'desconectado', 'GET /cliente/:id/conexoes (Frente 1) com a RLS da migration B', conexoes)
const outro = await usuario('AUDITOR_CLIENT')
ok((await chamar(`${HUB}/cliente/${clientId}/conexoes`, { jwt: outro.jwt })).status === 403, 'outro cliente → 403 no negócio alheio')
const rlsOutro = await chamar(`${API}/rest/v1/auditor_clientes?client_id=eq.${clientId}`, { jwt: outro.jwt })
ok(rlsOutro.status === 200 && rlsOutro.json.length === 0, 'RLS: outro cliente não lê o negócio (0 linhas)')
ok((await chamar(`${HUB}/auditor/operacao`, { jwt: cliente.jwt })).status === 403, 'operação: cliente → 403')
ok((await chamar(`${HUB}/auditor/copia/${randomUUID()}`)).status === 401, 'cópia WhatsApp sem login → 401')
ok((await chamar(`${HUB}/auditor/copia/${randomUUID()}`, { jwt: cliente.jwt })).status === 403, 'cópia WhatsApp: cliente → 403')

// 3 · relatório de verdade no runtime: sem fontes e sem Resend → gera achados e fica na fila do e-mail.
const rel = psql(`insert into public.auditor_relatorios (client_id, tipo, periodo_de, periodo_ate, executar_em)
  values ('${clientId}', 'retrospectiva', current_date - 28, current_date - 1, now() - interval '1 minute') returning id`).split('\n')[0]
const proc = await chamar(`${HUB}/internal/auditor/processar`, { metodo: 'POST', headers: { 'x-cron-secret': segredo } })
ok(proc.status === 200 && proc.json?.relatorios?.agendado === 1, 'processar gera e, sem Resend, devolve à fila', proc)
const linha = JSON.parse(psql(`select row_to_json(r) from (select estado, tentativas, erro, fontes, narrativa ->> 'origem' as origem, versao_regras from public.auditor_relatorios where id = '${rel}') r`))
ok(linha.estado === 'agendado' && linha.erro === 'email_falhou' && linha.tentativas === 1, 'estado agendado com erro email_falhou', linha)
ok(linha.fontes.meta_ads === 'sem_conexao' && linha.fontes.site === 'nao_disponivel' && linha.origem === 'modelo' && linha.versao_regras === 'r1',
  'fontes, texto de modelo (sem ANTHROPIC_API_KEY) e versão de regras gravados', linha)

// 4 · auditor-acesso: validação no runtime real.
const ac = `${API}/functions/v1/auditor-acesso`
ok((await chamar(ac, { metodo: 'POST', corpo: { email: 'x' } })).status === 400, 'auditor-acesso: e-mail inválido → 400')
ok((await chamar(ac, { metodo: 'POST', corpo: { email: 'a@b.com', aceite: false } })).status === 400, 'auditor-acesso: sem aceite → 400')
const emailNovo = `novo-${randomUUID().slice(0, 6)}@example.test`
const semResend = await chamar(ac, { metodo: 'POST', corpo: { email: emailNovo, aceite: true, aceite_versao: 'termos-2026-10-21' } })
ok(semResend.status === 502 && semResend.json?.motivo === 'indisponivel', 'auditor-acesso sem RESEND_API_KEY → 502 controlado', semResend)
// o usuário nasce antes do envio falhar; o teste não deixa sobra no banco
psql(`delete from auth.users where email = '${emailNovo}'`)

// 4b · checkout logado (C19): sem sessão 401 antes do Pagar.me; sessão sem conta do auditor 409.
const ck = `${API}/functions/v1/assinatura-auditor`
const semSessao = await chamar(ck, { metodo: 'POST', corpo: { plano: 'semanal' } })
ok(semSessao.status === 401 && semSessao.json?.motivo === 'login_necessario', 'assinatura-auditor sem sessão → 401', semSessao)
const semConta = await usuario('AUDITOR_CLIENT')
const r409 = await chamar(ck, { metodo: 'POST', jwt: semConta.jwt, corpo: { plano: 'semanal' } })
ok(r409.status === 409 && r409.json?.error_code === 'SEM_CONTA', 'assinatura-auditor com sessão sem conta → 409 SEM_CONTA', r409)
psql(`delete from auth.users where id = '${semConta.id}'`)

// 4c · webhook: só eventos do auditor (21/10). Credencial Basic só de teste local (AUDITOR_WEBHOOK_BASIC).
const BASIC = process.env.AUDITOR_WEBHOOK_BASIC
if (BASIC) {
  const wh = `${API}/functions/v1/assinatura-auditor-webhook`
  const ev = (id, data, tipo = 'charge.paid') => chamar(wh, { metodo: 'POST', corpo: { id, type: tipo, created_at: new Date().toISOString(), data }, headers: { authorization: `Basic ${Buffer.from(BASIC).toString('base64')}` } })
  const idFora = `hook_roteador_${randomUUID().slice(0, 8)}`
  const fora = await ev(idFora, { id: 'ch_r', status: 'paid', metadata: { origem: 'roteador' }, customer: { email: 'pessoa@exemplo.com' } })
  ok(fora.status === 200 && fora.json?.ignorado === 'fora_do_auditor', 'webhook: cobrança do Roteador → 200 fora_do_auditor', fora)
  ok(psql(`select count(*) from public.auditor_assinatura_eventos where gateway_event_id = '${idFora}'`) === '0', 'webhook: nada gravado do Roteador')
  const idNosso = `hook_auditor_${randomUUID().slice(0, 8)}`
  const nosso = await ev(idNosso, { id: 'sub_edge', status: 'canceled', metadata: { origem: 'auditor' } }, 'subscription.canceled')
  ok(nosso.status === 200 && psql(`select count(*) from public.auditor_assinatura_eventos where gateway_event_id = '${idNosso}'`) === '1', 'webhook: evento do auditor gravado', nosso)
  const idPlano = `hook_plano_${randomUUID().slice(0, 8)}`
  await ev(idPlano, { id: 'sub_edge2', plan: { id: 'plan_local_semanal' } }, 'subscription.canceled')
  ok(psql(`select count(*) from public.auditor_assinatura_eventos where gateway_event_id = '${idPlano}'`) === '1', 'webhook: plano do auditor gravado')
  psql(`delete from public.auditor_assinatura_eventos where gateway_event_id in ('${idNosso}', '${idPlano}')`)
}

// 5 · exclusão de conta (sem assinatura): apaga negócio, conta e usuário.
const exc = await chamar(`${HUB}/cliente/excluir-conta`, { metodo: 'POST', jwt: cliente.jwt, corpo: { confirmar: true } })
ok(exc.status === 200 && exc.json?.ok === true && /^[0-9a-f]{24}$/.test(exc.json.codigo), 'excluir-conta → 200 com código', exc)
ok(psql(`select count(*) from auth.users where id = '${cliente.id}'`) === '0', 'usuário apagado')
ok(psql(`select count(*) from public.clients where id = '${clientId}'`) === '0', 'negócio apagado')

// limpeza do outro usuário de teste
psql(`select public.auditor_apagar_conta(id, 'admin') from public.auditor_contas where dono_user_id = '${outro.id}'; delete from auth.users where id = '${outro.id}';`)
console.log(`\n${passes.length} verificações passaram.`)
