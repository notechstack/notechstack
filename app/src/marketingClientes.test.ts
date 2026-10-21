// @vitest-environment node
import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Chamador, type HubConfig, type MarketingStore, criarHandler } from '../../supabase/functions/marketing-hub/handler.ts'
import type { AtivoCliente, ClienteStore, ConexaoCliente } from '../../supabase/functions/marketing-hub/clientes.ts'
import { googleAccessToken, limparCacheGoogle } from '../../supabase/functions/_shared/marketing/google-auth.ts'
import {
  type StatePayload,
  OauthErro,
  assinarState,
  lerState,
  metaSignedRequest,
  pkceChallenge,
  pkceVerifier,
  urlConsentimentoGoogle,
  urlConsentimentoMeta,
} from '../../supabase/functions/_shared/marketing/oauth-cliente.ts'

// Fixtures: nenhum valor aqui é credencial real.
const AGORA = new Date('2026-10-21T15:00:00Z')
const SEGREDO = 'fixture-state-secret-com-mais-de-32-caracteres'
const META_SECRET = 'fixture-meta-secret'
const CLI_A = '11111111-1111-4111-8111-111111111111'
const CLI_B = '22222222-2222-4222-8222-222222222222'
const USER_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const USER_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const ADMIN = 'cccccccc-0000-4000-8000-00000000000c'
const DOT = 'dddddddd-0000-4000-8000-00000000000d'
const TOKEN_ADMIN_META = 'fixture-token-admin-meta'
const TOKEN_META_CURTO = 'fixture-meta-curto'
const TOKEN_META_LONGO = 'fixture-meta-longo'
const REFRESH_GOOGLE = 'fixture-google-refresh-cliente'
const ACCESS_GOOGLE = 'fixture-google-access-cliente'

const SESSOES: Record<string, Chamador> = {
  'cliente-a': { userId: USER_A, role: 'AUDITOR_CLIENT', aal: 'aal1', banido: false },
  'cliente-b': { userId: USER_B, role: 'AUDITOR_CLIENT', aal: 'aal1', banido: false },
  'cliente-a-banido': { userId: USER_A, role: 'AUDITOR_CLIENT', aal: 'aal1', banido: true },
  'admin-aal2': { userId: ADMIN, role: 'NO_ADMIN', aal: 'aal2', banido: false },
  'admin-aal1': { userId: ADMIN, role: 'NO_ADMIN', aal: 'aal1', banido: false },
  dot: { userId: DOT, role: 'MARKETING_AGENT', aal: 'aal1', banido: false },
}
// memberships AUDITOR em negócios com origem 'auditor'.
const MEMBROS: Record<string, string> = { [USER_A]: CLI_A, [USER_B]: CLI_B }

function clienteStoreEmMemoria(suporte: Set<string> = new Set()) {
  const nonces = new Map<string, string>()
  const conexoes = new Map<string, ConexaoCliente & { token: string | null; usuario: string | null }>()
  const ativos = new Map<string, AtivoCliente[]>()
  const eventos: { clientId: string | null; papel: string | null; acao: string; detalhe?: Record<string, unknown> }[] = []
  const desautorizados: string[] = []
  const k = (c: string, p: string) => `${c}:${p}`
  // Simula a RLS: o leitor só enxerga o negócio do dono do JWT (ou do suporte concedido).
  const podeLer = (jwt: string, c: string) => MEMBROS[SESSOES[jwt]?.userId] === c || suporte.has(`${SESSOES[jwt]?.userId}:${c}`)
  const store: ClienteStore = {
    async membroAuditor(userId, clientId) { return MEMBROS[userId] === clientId },
    async suporteVigente(userId, clientId) { return suporte.has(`${userId}:${clientId}`) },
    leitor(jwt) {
      return {
        async conexoesListar(c) {
          if (!podeLer(jwt, c)) return []
          return [...conexoes.entries()].filter(([key]) => key.startsWith(`${c}:`)).map(([, v]) => ({
            provedor: v.provedor, estado: v.estado, escopos: v.escopos, expira_em: v.expira_em, conectado_em: v.conectado_em,
            verificado_em: v.verificado_em, ultimo_erro: v.ultimo_erro, encerrado_em: v.encerrado_em,
          }))
        },
        async ativosListar(c) { return podeLer(jwt, c) ? ativos.get(c) ?? [] : [] },
      }
    },
    async evento(e) { eventos.push({ clientId: e.clientId, papel: e.papel, acao: e.acao, detalhe: e.detalhe }) },
    async nonceRegistrar(n, exp) { nonces.set(n, exp) },
    async nonceConsumir(n) {
      const exp = nonces.get(n)
      nonces.delete(n)
      return Boolean(exp && exp > AGORA.toISOString())
    },
    async conexaoSalvar(l) {
      conexoes.set(k(l.clientId, l.provedor), {
        provedor: l.provedor, estado: 'conectado', escopos: l.escopos, expira_em: l.expiraEm, conectado_em: AGORA.toISOString(),
        verificado_em: null, ultimo_erro: null, encerrado_em: null, token: l.token, usuario: l.usuarioExterno,
      })
    },
    async tokenLer(c, p) {
      const x = conexoes.get(k(c, p))
      return x?.estado === 'conectado' && x.token ? { token: x.token, escopos: x.escopos } : null
    },
    async conexaoMarcar(c, p, estado, codigo) {
      const x = conexoes.get(k(c, p))
      if (x?.estado !== 'conectado') return
      if (estado === 'verificado') x.verificado_em = AGORA.toISOString()
      else Object.assign(x, { estado, ultimo_erro: codigo })
    },
    async conexaoEncerrar(c, p, estado) {
      const x = conexoes.get(k(c, p))
      if (!x || x.estado === 'desconectado') return false
      Object.assign(x, { estado, token: null, escopos: [], encerrado_em: AGORA.toISOString() })
      ativos.set(c, (ativos.get(c) ?? []).filter((a) => (p === 'meta' ? a.tipo !== 'meta_ads' : a.tipo === 'meta_ads')))
      return true
    },
    async metaDesautorizar(u) { desautorizados.push(u); return 1 },
    async ativosSalvar(c, _p, novos) {
      const atuais = (ativos.get(c) ?? []).filter((a) => !novos.some((n) => n.tipo === a.tipo))
      ativos.set(c, [...atuais, ...novos])
    },
  }
  return { store, nonces, conexoes, ativos, eventos, desautorizados, suporte }
}

function storeHub(): MarketingStore & { cache: Map<string, unknown> } {
  const cache = new Map<string, unknown>()
  const nao = async () => { throw new Error('não usado') }
  return {
    cache,
    async cacheLer(c) { return cache.get(c) ?? null },
    async cacheGravar(c, v) { cache.set(c, v) },
    async cacheLimpar(p) { for (const c of [...cache.keys()]) if (c.startsWith(p)) cache.delete(c) },
    async agentePapel() { return null },
    async ativos() { return { clientId: 'cli-no', metaAds: { id: 'x', externalId: 'act_999' }, metaPage: null, metaInstagram: null } },
    acaoIniciar: nao, acaoFinalizar: nao, acoesListar: nao, escritasOk: async () => [], postsListar: nao, postInserir: nao,
    postBuscar: nao, postAtualizar: nao, postsReservarVencidos: nao, leadsOrigem: async () => [], leadsListar: nao, leadExiste: nao,
    leadClassificar: nao, cronSecretOk: async () => false, urlUpload: nao, urlLeitura: nao, baixarMidia: nao, agentesListar: nao,
    agenteConvidar: nao, agenteBanir: nao,
  } as MarketingStore & { cache: Map<string, unknown> }
}

const HUB = 'https://x.supabase.co/functions/v1/marketing-hub'
const VOLTA = 'https://app.notechstack.com.br/auditor/{client_id}/conexoes'

const CONFIG: HubConfig = {
  metaToken: TOKEN_ADMIN_META,
  google: { clientId: 'fixture-google-client', clientSecret: 'fixture-google-secret', refreshToken: 'fixture-refresh-admin', developerToken: null, customerId: null, loginCustomerId: null, ga4PropertyId: null, gscSiteUrl: null },
  googleCriacaoLiberada: false,
  appUrl: 'https://app.notechstack.com.br',
  clientes: { stateSecret: SEGREDO, hubUrl: HUB, voltaUrl: VOLTA, meta: { appId: '424242', appSecret: META_SECRET, configId: 'cfg-77' } },
}

function montar(config: Partial<HubConfig> = {}) {
  const cli = clienteStoreEmMemoria()
  const hub = storeHub()
  const logs: string[] = []
  const handler = criarHandler({
    store: hub,
    clienteStore: cli.store,
    autenticar: async (t) => SESSOES[t] ?? null,
    config: { ...CONFIG, ...config },
    agora: () => AGORA,
    esperar: async () => undefined,
    uuid: () => 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    log: (nivel, evento, dados) => { logs.push(JSON.stringify({ nivel, evento, dados })) },
  })
  const chamar = async (metodo: string, caminho: string, sessao?: string, corpo?: unknown, extra: Record<string, string> = {}) => {
    const resp = await handler(new Request(`${HUB}${caminho}`, {
      method: metodo,
      headers: { origin: 'https://app.notechstack.com.br', ...(sessao ? { authorization: `Bearer ${sessao}` } : {}), ...(corpo ? { 'content-type': 'application/json' } : {}), ...extra },
      body: corpo ? JSON.stringify(corpo) : undefined,
    }))
    return { status: resp.status, body: await resp.json().catch(() => null), headers: resp.headers }
  }
  return { ...cli, hub, chamar, handler, logs }
}

type Chamada = { url: URL; method: string; body: unknown; headers: Record<string, string> }
type Resposta = { status?: number; body: unknown }

function mockFetch(responder: (c: Chamada) => Resposta | undefined) {
  const chamadas: Chamada[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    let body: unknown = init?.body
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body) } catch { body = Object.fromEntries(new URLSearchParams(init.body)) }
    }
    const c: Chamada = { url: new URL(String(input)), method: init?.method ?? 'GET', body, headers: Object.fromEntries(new Headers(init?.headers).entries()) }
    chamadas.push(c)
    const r = responder(c) ?? { status: 400, body: { error: { message: `sem mock ${c.url}` } } }
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 })
  }))
  return chamadas
}

afterEach(() => {
  vi.unstubAllGlobals()
  limparCacheGoogle()
})

// Ida completa até o provedor: devolve state, cookie e o destino do 303.
async function iniciar(m: ReturnType<typeof montar>, provedor: 'meta' | 'google', sessao = 'cliente-a', clientId = CLI_A) {
  const r = await m.chamar('POST', `/cliente/${clientId}/${provedor}/conectar`, sessao)
  expect(r.status).toBe(200)
  const ir = new URL(r.body.url)
  const viaIr = await m.chamar('GET', `${ir.pathname.replace('/functions/v1/marketing-hub', '')}${ir.search}`)
  expect(viaIr.status).toBe(303)
  const cookie = (viaIr.headers.get('set-cookie') ?? '').split(';')[0]
  return { state: ir.searchParams.get('state')!, cookie, destino: new URL(viaIr.headers.get('location')!) }
}

const voltaDe = (r: { headers: Headers }) => new URL(r.headers.get('location')!)

// ---------------------------------------------------------------------------

describe('oauth-cliente — state assinado, PKCE e signed_request', () => {
  it('PKCE S256 confere com o vetor do RFC 7636 (apêndice B)', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('verifier derivado do nonce: 43 caracteres, estável e diferente por nonce', async () => {
    const v1 = await pkceVerifier(SEGREDO, 'a'.repeat(64))
    expect(v1).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await pkceVerifier(SEGREDO, 'a'.repeat(64))).toBe(v1)
    expect(await pkceVerifier(SEGREDO, 'b'.repeat(64))).not.toBe(v1)
  })

  const payload: StatePayload = { n: 'f'.repeat(64), c: CLI_A, u: USER_A, p: 'meta', e: Math.floor(AGORA.getTime() / 1000) + 600 }

  it('state válido volta igual', async () => {
    const s = await assinarState(SEGREDO, payload)
    expect(await lerState(SEGREDO, s, AGORA.getTime())).toEqual(payload)
  })

  it.each([
    ['payload trocado (outro cliente)', async (s: string) => {
      const [v, , sig] = s.split('.')
      return `${v}.${Buffer.from(JSON.stringify({ ...payload, c: CLI_B })).toString('base64url')}.${sig}`
    }, 'state_invalido'],
    ['assinatura de outro segredo', async () => assinarState('outro-segredo-qualquer-com-32-caracteres!!', payload), 'state_invalido'],
    ['lixo', async () => 'abc', 'state_invalido'],
    ['expirado', async () => assinarState(SEGREDO, { ...payload, e: Math.floor(AGORA.getTime() / 1000) - 1 }), 'state_expirado'],
  ])('rejeita %s', async (_nome, gerar, motivo) => {
    const s = await gerar(await assinarState(SEGREDO, payload))
    await expect(lerState(SEGREDO, s, AGORA.getTime())).rejects.toEqual(new OauthErro(motivo as never))
  })

  it('consentimento Meta: Login for Business usa config_id; sem ele, só ads_read', () => {
    const base = { appId: '424242', redirectUri: `${HUB}/cliente/meta/callback`, state: 'st', challenge: 'ch' }
    const comConfig = new URL(urlConsentimentoMeta({ ...base, configId: 'cfg-77' }))
    expect(comConfig.pathname).toMatch(/^\/v\d+\.0\/dialog\/oauth$/)
    expect(comConfig.searchParams.get('config_id')).toBe('cfg-77')
    expect(comConfig.searchParams.has('scope')).toBe(false)
    expect(comConfig.searchParams.get('code_challenge_method')).toBe('S256')
    expect(new URL(urlConsentimentoMeta({ ...base, configId: null })).searchParams.get('scope')).toBe('ads_read')
  })

  it('consentimento Google: 3 escopos de leitura, offline, consent e S256', () => {
    const u = new URL(urlConsentimentoGoogle({ clientId: 'cid', redirectUri: `${HUB}/cliente/google/callback`, state: 'st', challenge: 'ch' }))
    expect(u.searchParams.get('scope')!.split(' ')).toEqual([
      'https://www.googleapis.com/auth/adwords',
      'https://www.googleapis.com/auth/analytics.readonly',
      'https://www.googleapis.com/auth/webmasters.readonly',
    ])
    expect(u.searchParams.get('access_type')).toBe('offline')
    expect(u.searchParams.get('prompt')).toBe('consent')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('signed_request da Meta: aceita só com o app secret certo e HMAC-SHA256', async () => {
    const assinar = (corpo: object, segredo = META_SECRET) => {
      const p = Buffer.from(JSON.stringify(corpo)).toString('base64url')
      return `${createHmac('sha256', segredo).update(p).digest('base64url')}.${p}`
    }
    expect(await metaSignedRequest(META_SECRET, assinar({ algorithm: 'HMAC-SHA256', user_id: '9001' }))).toEqual({ userId: '9001' })
    expect(await metaSignedRequest(META_SECRET, assinar({ algorithm: 'HMAC-SHA256', user_id: '9001' }, 'outro'))).toBeNull()
    expect(await metaSignedRequest(META_SECRET, assinar({ algorithm: 'none', user_id: '9001' }))).toBeNull()
    expect(await metaSignedRequest(META_SECRET, 'lixo')).toBeNull()
  })
})

describe('/cliente — quem pode o quê (spec, seção 2)', () => {
  it.each([
    [undefined, CLI_A, 401, 'UNAUTHENTICATED'],
    ['cliente-a-banido', CLI_A, 401, 'UNAUTHENTICATED'],
    ['cliente-a', CLI_B, 403, 'FORBIDDEN'],
    ['cliente-b', CLI_A, 403, 'FORBIDDEN'],
    ['cliente-a', '33333333-3333-4333-8333-333333333333', 403, 'FORBIDDEN'],
    ['cliente-a', 'nao-e-uuid', 403, 'FORBIDDEN'],
    ['dot', CLI_A, 403, 'FORBIDDEN'],
    ['admin-aal1', CLI_A, 403, 'MFA_REQUIRED'],
    ['admin-aal2', CLI_A, 403, 'FORBIDDEN'],
  ])('conectar: sessão %s no negócio %s recebe %i', async (sessao, clientId, status, codigo) => {
    const m = montar()
    const r = await m.chamar('POST', `/cliente/${clientId}/meta/conectar`, sessao)
    expect(r.status).toBe(status)
    expect(r.body.error_code).toBe(codigo)
    expect(m.nonces.size).toBe(0)
  })

  it('o client_id do corpo é ignorado: vale só o da URL', async () => {
    const m = montar()
    const r = await m.chamar('POST', `/cliente/${CLI_B}/meta/conectar`, 'cliente-a', { client_id: CLI_A })
    expect(r.status).toBe(403)
  })

  it('membro recebe a URL de /ir, sem cache', async () => {
    const m = montar()
    const r = await m.chamar('POST', `/cliente/${CLI_A}/google/conectar`, 'cliente-a')
    expect(r.status).toBe(200)
    expect(r.body.url).toMatch(new RegExp(`^${HUB}/cliente/google/ir\\?state=v1\\.`))
    expect(r.headers.get('cache-control')).toBe('no-store')
  })

  it('NO_ADMIN sem concessão não lê; com concessão lê (registrado) e continua sem escrever', async () => {
    const m = montar()
    expect((await m.chamar('GET', `/cliente/${CLI_A}/conexoes`, 'admin-aal2')).status).toBe(403)
    expect((await m.chamar('GET', `/cliente/${CLI_A}/overview?periodo=7d`, 'admin-aal2')).status).toBe(403)
    m.suporte.add(`${ADMIN}:${CLI_A}`)
    const leu = await m.chamar('GET', `/cliente/${CLI_A}/conexoes`, 'admin-aal2')
    expect(leu.status).toBe(200)
    expect(m.eventos).toContainEqual(expect.objectContaining({ clientId: CLI_A, papel: 'NO_ADMIN', acao: 'suporte_leu' }))
    expect((await m.chamar('POST', `/cliente/${CLI_A}/meta/conectar`, 'admin-aal2')).status).toBe(403)
    expect((await m.chamar('DELETE', `/cliente/${CLI_A}/meta`, 'admin-aal2')).status).toBe(403)
    expect((await m.chamar('POST', `/cliente/${CLI_A}/ativos`, 'admin-aal2', { ga4: '1' })).status).toBe(403)
    expect((await m.chamar('GET', `/cliente/${CLI_A}/meta/contas`, 'admin-aal2')).status).toBe(403)
  })

  it('sem segredo de state (ou curto demais) responde 503 e não cria nonce', async () => {
    for (const stateSecret of [null, 'curto']) {
      const m = montar({ clientes: { ...CONFIG.clientes!, stateSecret } })
      const r = await m.chamar('POST', `/cliente/${CLI_A}/meta/conectar`, 'cliente-a')
      expect(r.status).toBe(503)
      expect(m.nonces.size).toBe(0)
    }
  })

  it('o cliente continua sem acesso às rotas do admin (/overview segue 403)', async () => {
    const m = montar()
    expect((await m.chamar('GET', '/overview?periodo=7d', 'cliente-a')).status).toBe(403)
  })
})

function metaOk(c: Chamada, extra: Partial<{ appId: string; scopes: string[]; expiresAt: number }> = {}): Resposta | undefined {
  const p = c.url.pathname
  if (p.endsWith('/oauth/access_token') && c.url.searchParams.get('code')) return { body: { access_token: TOKEN_META_CURTO } }
  if (p.endsWith('/oauth/access_token') && c.url.searchParams.get('grant_type') === 'fb_exchange_token') return { body: { access_token: TOKEN_META_LONGO, expires_in: 5_184_000 } }
  if (p.endsWith('/debug_token')) {
    return { body: { data: { app_id: extra.appId ?? '424242', is_valid: true, scopes: extra.scopes ?? ['ads_read', 'public_profile'], user_id: '9001', expires_at: extra.expiresAt ?? 1_766_000_000 } } }
  }
  return undefined
}

describe('/cliente/meta — ida e volta', () => {
  it('ida: /ir põe cookie HttpOnly e manda ao Facebook com o challenge do verifier', async () => {
    const m = montar()
    const { state, cookie, destino } = await iniciar(m, 'meta')
    const s = await lerState(SEGREDO, state, AGORA.getTime())
    expect(cookie).toBe(`__Host-no_oauth_meta=${s.n}`)
    expect(destino.host).toBe('www.facebook.com')
    expect(destino.searchParams.get('redirect_uri')).toBe(`${HUB}/cliente/meta/callback`)
    expect(destino.searchParams.get('code_challenge')).toBe(await pkceChallenge(await pkceVerifier(SEGREDO, s.n)))
    expect(destino.searchParams.get('config_id')).toBe('cfg-77')
  })

  it('volta ok: troca com code_verifier, guarda o token longo e volta às conexões do negócio no app', async () => {
    const m = montar()
    const { state, cookie } = await iniciar(m, 'meta')
    const chamadas = mockFetch((c) => metaOk(c))
    const r = await m.chamar('GET', `/cliente/meta/callback?code=CODE1&state=${state}`, undefined, undefined, { cookie })
    expect(r.status).toBe(303)
    const volta = voltaDe(r)
    expect(`${volta.origin}${volta.pathname}`).toBe(`https://app.notechstack.com.br/auditor/${CLI_A}/conexoes`)
    expect(volta.searchParams.get('resultado')).toBe('ok')
    expect(volta.searchParams.get('conexao')).toBe('meta')
    expect(r.headers.get('set-cookie')).toContain('Max-Age=0')

    const s = await lerState(SEGREDO, state, AGORA.getTime())
    const troca = chamadas.find((c) => c.url.searchParams.get('code') === 'CODE1')!
    expect(troca.url.searchParams.get('code_verifier')).toBe(await pkceVerifier(SEGREDO, s.n))
    expect(troca.url.searchParams.get('redirect_uri')).toBe(`${HUB}/cliente/meta/callback`)

    const salvo = m.conexoes.get(`${CLI_A}:meta`)!
    expect(salvo.token).toBe(TOKEN_META_LONGO)
    expect(salvo.usuario).toBe('9001')
    expect(salvo.expira_em).toBe(new Date(1_766_000_000 * 1000).toISOString())
    expect(m.logs.join()).not.toContain(TOKEN_META_LONGO)
    expect(m.logs.join()).not.toContain(TOKEN_META_CURTO)
  })

  it('token de usuário do sistema (sem expiração, troca longa recusada) é aceito com expira_em nulo', async () => {
    const m = montar()
    const { state, cookie } = await iniciar(m, 'meta')
    mockFetch((c) => (c.url.searchParams.get('grant_type') === 'fb_exchange_token' ? { status: 400, body: { error: { message: 'n/a' } } } : metaOk(c, { expiresAt: 0 })))
    const r = await m.chamar('GET', `/cliente/meta/callback?code=C&state=${state}`, undefined, undefined, { cookie })
    expect(voltaDe(r).searchParams.get('resultado')).toBe('ok')
    expect(m.conexoes.get(`${CLI_A}:meta`)).toMatchObject({ token: TOKEN_META_CURTO, expira_em: null })
  })

  it('state usado uma vez só', async () => {
    const m = montar()
    const { state, cookie } = await iniciar(m, 'meta')
    mockFetch((c) => metaOk(c))
    await m.chamar('GET', `/cliente/meta/callback?code=C&state=${state}`, undefined, undefined, { cookie })
    const r = await m.chamar('GET', `/cliente/meta/callback?code=C&state=${state}`, undefined, undefined, { cookie })
    expect(voltaDe(r).searchParams.get('motivo')).toBe('state_reusado')
  })

  it('outro navegador (sem o cookie de /ir) é recusado e não queima o nonce', async () => {
    const m = montar()
    const { state } = await iniciar(m, 'meta')
    const chamadas = mockFetch((c) => metaOk(c))
    const r = await m.chamar('GET', `/cliente/meta/callback?code=C&state=${state}`, undefined, undefined, { cookie: '__Host-no_oauth_meta=' + '0'.repeat(64) })
    expect(voltaDe(r).searchParams.get('motivo')).toBe('navegador_diferente')
    expect(chamadas).toHaveLength(0)
    expect(m.nonces.size).toBe(1)
  })

  it.each([
    ['state adulterado', (s: string) => s.slice(0, -2) + 'xx', {}, 'state_invalido'],
    ['state de outro provedor', null, {}, 'state_invalido'],
    ['usuário negou', (s: string) => s, { error: 'access_denied', error_reason: 'user_denied' }, 'access_denied'],
  ])('%s volta com erro e não salva nada', async (_n, mexer, extra, motivo) => {
    const m = montar()
    const ida = await iniciar(m, mexer ? 'meta' : 'google')
    const state = mexer ? mexer(ida.state) : ida.state
    mockFetch((c) => metaOk(c))
    const q = new URLSearchParams({ state, ...(extra as Record<string, string>) })
    if (!('error' in extra)) q.set('code', 'C')
    const r = await m.chamar('GET', `/cliente/meta/callback?${q}`, undefined, undefined, { cookie: ida.cookie.replace('google', 'meta') })
    expect(voltaDe(r).searchParams.get('resultado')).toBe('erro')
    expect(voltaDe(r).searchParams.get('motivo')).toBe(motivo)
    expect(m.conexoes.size).toBe(0)
  })

  it.each([
    ['token de outro app', { appId: '999' }, 'troca_falhou'],
    ['sem ads_read', { scopes: ['public_profile'] }, 'escopo_insuficiente'],
  ])('%s não entra no Vault', async (_n, extra, motivo) => {
    const m = montar()
    const { state, cookie } = await iniciar(m, 'meta')
    mockFetch((c) => metaOk(c, extra))
    const r = await m.chamar('GET', `/cliente/meta/callback?code=C&state=${state}`, undefined, undefined, { cookie })
    expect(voltaDe(r).searchParams.get('motivo')).toBe(motivo)
    expect(m.conexoes.size).toBe(0)
  })

  it('quem perdeu o acesso ao negócio durante o consentimento não conecta', async () => {
    const m = montar()
    const { state, cookie } = await iniciar(m, 'meta')
    const antes = MEMBROS[USER_A]
    MEMBROS[USER_A] = CLI_B
    try {
      mockFetch((c) => metaOk(c))
      const r = await m.chamar('GET', `/cliente/meta/callback?code=C&state=${state}`, undefined, undefined, { cookie })
      expect(voltaDe(r).searchParams.get('motivo')).toBe('state_invalido')
      expect(voltaDe(r).pathname).toBe('/auditor/')
      expect(m.conexoes.size).toBe(0)
    } finally {
      MEMBROS[USER_A] = antes
    }
  })

  it('deauthorize: signed_request válido encerra as conexões do usuário Meta; inválido é 400', async () => {
    const m = montar()
    const p = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: '9001', issued_at: 1 })).toString('base64url')
    const sr = `${createHmac('sha256', META_SECRET).update(p).digest('base64url')}.${p}`
    const form = (v: string) => m.handler(new Request(`${HUB}/cliente/meta/desautorizar`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ signed_request: v }).toString(),
    }))
    expect((await form(sr)).status).toBe(200)
    expect(m.desautorizados).toEqual(['9001'])
    expect((await form(sr.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')))).status).toBe(400)
    expect(m.desautorizados).toHaveLength(1)
  })
})

const ESCOPOS_GOOGLE = 'https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/webmasters.readonly'

function googleOk(c: Chamada): Resposta | undefined {
  if (c.url.href === 'https://oauth2.googleapis.com/token') {
    const b = c.body as Record<string, string>
    if (b.grant_type === 'authorization_code') return { body: { refresh_token: REFRESH_GOOGLE, access_token: 'x', scope: ESCOPOS_GOOGLE } }
    if (b.grant_type === 'refresh_token' && b.refresh_token === REFRESH_GOOGLE) return { body: { access_token: ACCESS_GOOGLE, expires_in: 3600 } }
    if (b.grant_type === 'refresh_token' && b.refresh_token.startsWith('refresh-')) return { body: { access_token: `access-de-${b.refresh_token}`, expires_in: 3600 } }
    return { status: 400, body: { error: 'invalid_grant' } }
  }
  return undefined
}

describe('/cliente/google — ida e volta', () => {
  it('?hl=en vai assinado no state e chega à tela de consentimento; sem hl, nada muda', async () => {
    const m = montar()
    const r = await m.chamar('POST', `/cliente/${CLI_A}/google/conectar?hl=en`, 'cliente-a')
    const ir = new URL(r.body.url)
    expect((await lerState(SEGREDO, ir.searchParams.get('state')!, AGORA.getTime())).l).toBe('en')
    const via = await m.chamar('GET', `/cliente/google/ir${ir.search}`)
    expect(new URL(via.headers.get('location')!).searchParams.get('hl')).toBe('en')
    const { destino } = await iniciar(m, 'google')
    expect(destino.searchParams.has('hl')).toBe(false)
  })

  it.each([['google', 'fr'], ['meta', 'en']])('hl inválido (%s, %s) é 422 e não cria nonce', async (prov, hl) => {
    const m = montar()
    const r = await m.chamar('POST', `/cliente/${CLI_A}/${prov}/conectar?hl=${hl}`, 'cliente-a')
    expect(r.status).toBe(422)
    expect(m.nonces.size).toBe(0)
  })

  it('volta ok: troca com code_verifier e guarda o refresh token com os escopos concedidos', async () => {
    const m = montar()
    const { state, cookie, destino } = await iniciar(m, 'google')
    expect(destino.host).toBe('accounts.google.com')
    const chamadas = mockFetch(googleOk)
    const r = await m.chamar('GET', `/cliente/google/callback?code=G1&state=${state}`, undefined, undefined, { cookie })
    expect(voltaDe(r).searchParams.get('resultado')).toBe('ok')
    const s = await lerState(SEGREDO, state, AGORA.getTime())
    expect(chamadas[0].body).toMatchObject({ code: 'G1', code_verifier: await pkceVerifier(SEGREDO, s.n), redirect_uri: `${HUB}/cliente/google/callback` })
    expect(m.conexoes.get(`${CLI_A}:google`)).toMatchObject({ token: REFRESH_GOOGLE, escopos: ESCOPOS_GOOGLE.split(' ') })
  })

  it('consentimento parcial (só Analytics) conecta só com o que foi concedido', async () => {
    const m = montar()
    const { state, cookie } = await iniciar(m, 'google')
    mockFetch(() => ({ body: { refresh_token: REFRESH_GOOGLE, scope: 'openid https://www.googleapis.com/auth/analytics.readonly' } }))
    await m.chamar('GET', `/cliente/google/callback?code=G&state=${state}`, undefined, undefined, { cookie })
    expect(m.conexoes.get(`${CLI_A}:google`)!.escopos).toEqual(['https://www.googleapis.com/auth/analytics.readonly'])
  })

  it('sem nenhum dos três escopos não conecta', async () => {
    const m = montar()
    const { state, cookie } = await iniciar(m, 'google')
    mockFetch(() => ({ body: { refresh_token: REFRESH_GOOGLE, scope: 'openid email' } }))
    const r = await m.chamar('GET', `/cliente/google/callback?code=G&state=${state}`, undefined, undefined, { cookie })
    expect(voltaDe(r).searchParams.get('motivo')).toBe('escopo_insuficiente')
    expect(m.conexoes.size).toBe(0)
  })
})

describe('google-auth — cache de access token por credencial (bloqueio da Frente 3)', () => {
  it('dois clientes alternados no mesmo worker nunca trocam de token e não renovam à toa', async () => {
    const chamadas = mockFetch(googleOk)
    const cred = (r: string) => ({ clientId: 'cid', clientSecret: 'sec', refreshToken: r })
    const agora = AGORA.getTime()
    for (let i = 0; i < 3; i++) {
      expect(await googleAccessToken(cred('refresh-A'), agora)).toBe('access-de-refresh-A')
      expect(await googleAccessToken(cred('refresh-B'), agora)).toBe('access-de-refresh-B')
    }
    expect(chamadas).toHaveLength(2)
    // Vencido, renova só aquele.
    expect(await googleAccessToken(cred('refresh-A'), agora + 3_600_000)).toBe('access-de-refresh-A')
    expect(chamadas).toHaveLength(3)
  })
})

async function conectado(m: ReturnType<typeof montar>, provedor: 'meta' | 'google', escopos = provedor === 'meta' ? ['ads_read'] : ESCOPOS_GOOGLE.split(' '), clientId = CLI_A, token?: string) {
  await m.store.conexaoSalvar({ clientId, provedor, token: token ?? (provedor === 'meta' ? TOKEN_META_LONGO : REFRESH_GOOGLE), escopos, expiraEm: null, usuarioExterno: null, userId: USER_A })
}

function contasMeta(c: Chamada): Resposta | undefined {
  if (c.url.pathname.endsWith('/me/adaccounts') && !c.url.searchParams.get('after')) {
    return { body: { data: [{ id: 'act_123', name: 'Loja A', currency: 'BRL', account_status: 1 }], paging: { next: `${c.url.origin}${c.url.pathname}?access_token=${c.url.searchParams.get('access_token')}&after=p2` } } }
  }
  if (c.url.pathname.endsWith('/me/adaccounts')) return { body: { data: [{ id: 'act_456', name: 'Loja A antiga', currency: 'BRL', account_status: 2 }] } }
  return undefined
}

function contasGoogle(c: Chamada): Resposta | undefined {
  const t = googleOk(c)
  if (t) return t
  const u = c.url.href
  if (u.endsWith('/customers:listAccessibleCustomers')) return { body: { resourceNames: ['customers/1112223333', 'customers/9998887777'] } }
  if (u.endsWith('/customers/1112223333/googleAds:search')) return { body: { results: [{ customer: { id: '1112223333', descriptiveName: 'Loja A Ads', manager: false, currencyCode: 'BRL' } }] } }
  if (u.endsWith('/customers/9998887777/googleAds:search')) {
    const q = String((c.body as { query: string }).query)
    if (q.includes('FROM customer_client')) return { body: { results: [{ customerClient: { id: '5556667777', descriptiveName: 'Filial', manager: false, currencyCode: 'BRL' } }] } }
    return { body: { results: [{ customer: { id: '9998887777', descriptiveName: 'MCC do cliente', manager: true } }] } }
  }
  if (u.startsWith('https://analyticsadmin.googleapis.com/v1beta/accountSummaries')) {
    return { body: { accountSummaries: [{ displayName: 'Conta A', propertySummaries: [{ property: 'properties/321', displayName: 'Site A' }] }] } }
  }
  if (u === 'https://www.googleapis.com/webmasters/v3/sites') {
    return { body: { siteEntry: [{ siteUrl: 'sc-domain:lojaa.com.br', permissionLevel: 'siteOwner' }, { siteUrl: 'https://nao.verificado/', permissionLevel: 'siteUnverifiedUser' }] } }
  }
  return undefined
}

describe('/cliente — contas e seleção', () => {
  it('Meta: lista os act_* do token do cliente, com paginação, sem tocar no token da Nó', async () => {
    const m = montar()
    await conectado(m, 'meta')
    const chamadas = mockFetch(contasMeta)
    const r = await m.chamar('GET', `/cliente/${CLI_A}/meta/contas`, 'cliente-a')
    expect(r.status).toBe(200)
    expect(r.body.meta_ads.map((c: { external_id: string }) => c.external_id)).toEqual(['act_123', 'act_456'])
    expect(r.body.meta_ads[0]).toMatchObject({ moeda: 'BRL', detalhe: null })
    expect(r.body.meta_ads[1].detalhe).toBe('inativa')
    expect(chamadas.every((c) => c.url.searchParams.get('access_token') === TOKEN_META_LONGO)).toBe(true)
    expect(m.conexoes.get(`${CLI_A}:meta`)!.verificado_em).toBe(AGORA.toISOString())
  })

  it('Google: customers diretos e filhos de MCC, propriedades GA4 e sites verificados', async () => {
    const m = montar()
    await conectado(m, 'google')
    const chamadas = mockFetch(contasGoogle)
    const r = await m.chamar('GET', `/cliente/${CLI_A}/google/contas`, 'cliente-a')
    expect(r.status).toBe(200)
    expect(r.body.google_ads).toEqual([
      expect.objectContaining({ external_id: '1112223333', login_customer_id: null, moeda: 'BRL' }),
      expect.objectContaining({ external_id: '5556667777', login_customer_id: '9998887777' }),
    ])
    expect(r.body.ga4).toEqual([expect.objectContaining({ external_id: '321', nome: 'Site A' })])
    expect(r.body.gsc.map((s: { external_id: string }) => s.external_id)).toEqual(['sc-domain:lojaa.com.br'])
    // Sem developer token configurado o cabeçalho não vai; o refresh usado é o do cliente.
    expect(chamadas.filter((c) => c.url.host === 'googleads.googleapis.com').every((c) => !('developer-token' in c.headers))).toBe(true)
    expect(chamadas.filter((c) => c.url.host !== 'oauth2.googleapis.com').every((c) => c.headers.authorization === `Bearer ${ACCESS_GOOGLE}`)).toBe(true)
  })

  it('Google com só Analytics concedido não consulta Ads nem Search Console', async () => {
    const m = montar()
    await conectado(m, 'google', ['https://www.googleapis.com/auth/analytics.readonly'])
    const chamadas = mockFetch(contasGoogle)
    const r = await m.chamar('GET', `/cliente/${CLI_A}/google/contas`, 'cliente-a')
    expect(r.body).toMatchObject({ google_ads: null, gsc: null })
    expect(chamadas.some((c) => c.url.host === 'googleads.googleapis.com')).toBe(false)
  })

  it('sem conexão responde 409 NAO_CONECTADO', async () => {
    const m = montar()
    expect((await m.chamar('GET', `/cliente/${CLI_A}/meta/contas`, 'cliente-a')).status).toBe(409)
  })

  it('grava só o que o token lista agora (Meta e Google juntos); id fora da lista é 422', async () => {
    const m = montar()
    await conectado(m, 'google')
    await conectado(m, 'meta')
    mockFetch((c) => contasGoogle(c) ?? contasMeta(c))
    const ok = await m.chamar('POST', `/cliente/${CLI_A}/ativos`, 'cliente-a', {
      meta_ads: 'act_123', google_ads: { customer_id: '5556667777', login_customer_id: '9998887777' }, ga4: '321', gsc: 'sc-domain:lojaa.com.br',
    })
    expect(ok.status).toBe(200)
    expect(m.ativos.get(CLI_A)).toHaveLength(4)
    expect(m.ativos.get(CLI_A)!.find((a) => a.tipo === 'meta_ads')).toMatchObject({ moeda: 'BRL' })
    const fora = await m.chamar('POST', `/cliente/${CLI_A}/ativos`, 'cliente-a', { ga4: '999' })
    expect(fora.status).toBe(422)
    expect(fora.body).toMatchObject({ error_code: 'CONTA_NAO_DISPONIVEL', campos: ['ga4'] })
    expect((await m.chamar('POST', `/cliente/${CLI_A}/ativos`, 'cliente-a', { google_ads: { customer_id: '5556667777' } })).status).toBe(422)
    expect((await m.chamar('POST', `/cliente/${CLI_A}/ativos`, 'cliente-a', { meta_ads: 7 })).status).toBe(422)
  })

  it('cliente B não lista, não grava, não lê e não desconecta nada do cliente A', async () => {
    const m = montar()
    await conectado(m, 'meta')
    const chamadas = mockFetch(contasMeta)
    expect((await m.chamar('GET', `/cliente/${CLI_A}/meta/contas`, 'cliente-b')).status).toBe(403)
    expect((await m.chamar('POST', `/cliente/${CLI_A}/ativos`, 'cliente-b', { meta_ads: 'act_123' })).status).toBe(403)
    expect((await m.chamar('GET', `/cliente/${CLI_A}/conexoes`, 'cliente-b')).status).toBe(403)
    expect((await m.chamar('GET', `/cliente/${CLI_A}/overview?periodo=7d`, 'cliente-b')).status).toBe(403)
    expect((await m.chamar('DELETE', `/cliente/${CLI_A}/meta`, 'cliente-b')).status).toBe(403)
    expect(chamadas).toHaveLength(0)
    expect(await m.store.tokenLer(CLI_A, 'meta')).not.toBeNull()
  })
})

describe('/cliente — métricas com a credencial do cliente', () => {
  function plataformas(c: Chamada): Resposta | undefined {
    const g = googleOk(c)
    if (g) return g
    if (c.url.host === 'graph.facebook.com' && c.url.pathname.endsWith('/insights')) return { body: { data: [{ spend: '12.34', impressions: '1000', clicks: '10' }] } }
    if (c.url.host === 'graph.facebook.com' && c.url.pathname.endsWith('/act_123')) return { body: { id: 'act_123', currency: 'BRL', timezone_name: 'America/Sao_Paulo' } }
    if (c.url.href.endsWith('/properties/321:batchRunReports')) return { body: { reports: [] } }
    return undefined
  }
  const ativo = (tipo: AtivoCliente['tipo'], external_id: string): AtivoCliente => ({ tipo, external_id, nome: null, login_customer_id: null, moeda: null, detalhe: null })

  it('overview lê Meta e GA4 do cliente reaproveitando os adaptadores; o token da Nó nunca sai', async () => {
    const m = montar()
    await conectado(m, 'meta')
    await conectado(m, 'google')
    m.ativos.set(CLI_A, [ativo('meta_ads', 'act_123'), ativo('ga4', '321')])
    const chamadas = mockFetch(plataformas)
    const r = await m.chamar('GET', `/cliente/${CLI_A}/overview?periodo=7d`, 'cliente-a')
    expect(r.status).toBe(200)
    expect(r.body.blocos.meta_ads).toMatchObject({ ok: true, dados: { total: { gasto_centavos: 1234 } } })
    expect(r.body.blocos.ga4.ok).toBe(true)
    expect(r.body.blocos.google_ads).toMatchObject({ ok: false, motivo: 'nao_configurado' })
    expect(r.body.blocos.search_console).toMatchObject({ ok: false, motivo: 'nao_configurado' })
    const graph = chamadas.filter((c) => c.url.host === 'graph.facebook.com')
    expect(graph.length).toBeGreaterThan(0)
    expect(graph.every((c) => c.url.searchParams.get('access_token') === TOKEN_META_LONGO)).toBe(true)
    expect(JSON.stringify(chamadas)).not.toContain(TOKEN_ADMIN_META)
    expect(JSON.stringify(chamadas)).not.toContain('fixture-refresh-admin')
    // Cache separado por negócio (cli:<client_id>:), nunca as chaves do admin.
    expect([...m.hub.cache.keys()].every((k) => k.startsWith(`cli:${CLI_A}:`))).toBe(true)
  })

  it('dois negócios Google no mesmo worker leem cada um com o próprio token', async () => {
    const m = montar()
    MEMBROS[USER_B] = CLI_B
    await conectado(m, 'google', undefined, CLI_A, 'refresh-A')
    await conectado(m, 'google', undefined, CLI_B, 'refresh-B')
    m.ativos.set(CLI_A, [ativo('ga4', '321')])
    m.ativos.set(CLI_B, [ativo('ga4', '654')])
    const chamadas = mockFetch((c) => googleOk(c) ?? (c.url.href.includes(':batchRunReports') ? { body: { reports: [] } } : undefined))
    await m.chamar('GET', `/cliente/${CLI_A}/overview?periodo=7d&fresco=1`, 'cliente-a')
    await m.chamar('GET', `/cliente/${CLI_B}/overview?periodo=7d&fresco=1`, 'cliente-b')
    await m.chamar('GET', `/cliente/${CLI_A}/overview?periodo=7d&fresco=1`, 'cliente-a')
    const ga4 = chamadas.filter((c) => c.url.host === 'analyticsdata.googleapis.com')
    expect(ga4.map((c) => c.headers.authorization)).toEqual([
      'Bearer access-de-refresh-A', 'Bearer access-de-refresh-B', 'Bearer access-de-refresh-A',
    ])
    expect(ga4.map((c) => c.url.pathname)).toEqual([
      '/v1beta/properties/321:batchRunReports', '/v1beta/properties/654:batchRunReports', '/v1beta/properties/321:batchRunReports',
    ])
  })

  it('Meta 190 marca a conexão como expirada só com o código', async () => {
    const m = montar()
    await conectado(m, 'meta')
    m.ativos.set(CLI_A, [ativo('meta_ads', 'act_123')])
    mockFetch(() => ({ status: 400, body: { error: { message: 'Error validating access token', type: 'OAuthException', code: 190 } } }))
    const r = await m.chamar('GET', `/cliente/${CLI_A}/overview?periodo=7d`, 'cliente-a')
    expect(r.body.blocos.meta_ads.ok).toBe(false)
    expect(m.conexoes.get(`${CLI_A}:meta`)).toMatchObject({ estado: 'expirado', ultimo_erro: 'meta_190' })
    const c = await m.chamar('GET', `/cliente/${CLI_A}/conexoes`, 'cliente-a')
    expect(c.body.conexoes.meta.estado).toBe('expirado')
  })

  it('Google invalid_grant marca a conexão como expirada', async () => {
    const m = montar()
    await conectado(m, 'google', undefined, CLI_A, 'token-revogado')
    m.ativos.set(CLI_A, [ativo('ga4', '321')])
    mockFetch(googleOk)
    await m.chamar('GET', `/cliente/${CLI_A}/overview?periodo=7d`, 'cliente-a')
    expect(m.conexoes.get(`${CLI_A}:google`)).toMatchObject({ estado: 'expirado', ultimo_erro: 'google_invalid_grant' })
  })

  it('/conexoes mostra expirado quando o token longo da Meta passou da validade, sem token na resposta', async () => {
    const m = montar()
    await m.store.conexaoSalvar({ clientId: CLI_A, provedor: 'meta', token: TOKEN_META_LONGO, escopos: ['ads_read'], expiraEm: '2026-10-20T00:00:00Z', usuarioExterno: null, userId: USER_A })
    const r = await m.chamar('GET', `/cliente/${CLI_A}/conexoes`, 'cliente-a')
    expect(r.body.conexoes.meta.estado).toBe('expirado')
    expect(r.body.conexoes.google.estado).toBe('desconectado')
    expect(JSON.stringify(r.body)).not.toContain(TOKEN_META_LONGO)
  })
})

describe('/cliente — desconectar', () => {
  it('Meta: revoga no provedor com o token do cliente, apaga do Vault e marca desconectado', async () => {
    const m = montar()
    await conectado(m, 'meta')
    const chamadas = mockFetch((c) => (c.method === 'DELETE' && c.url.pathname.endsWith('/me/permissions') ? { body: { success: true } } : undefined))
    const r = await m.chamar('DELETE', `/cliente/${CLI_A}/meta`, 'cliente-a')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ estado: 'desconectado', havia_conexao: true, revogado_no_provedor: true })
    expect(chamadas[0].url.searchParams.get('access_token')).toBe(TOKEN_META_LONGO)
    expect(await m.store.tokenLer(CLI_A, 'meta')).toBeNull()
    expect(m.conexoes.get(`${CLI_A}:meta`)!.estado).toBe('desconectado')
  })

  it('Google: falha no provedor não impede apagar do Vault', async () => {
    const m = montar()
    await conectado(m, 'google')
    const chamadas = mockFetch(() => ({ status: 400, body: { error: 'invalid_token' } }))
    const r = await m.chamar('DELETE', `/cliente/${CLI_A}/google`, 'cliente-a')
    expect(r.body).toMatchObject({ estado: 'desconectado', revogado_no_provedor: false })
    expect(chamadas[0].url.href).toBe('https://oauth2.googleapis.com/revoke')
    expect(chamadas[0].body).toEqual({ token: REFRESH_GOOGLE })
    expect(await m.store.tokenLer(CLI_A, 'google')).toBeNull()
  })
})
