// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Chamador, type HubConfig, type MarketingStore, criarHandler } from '../../supabase/functions/marketing-hub/handler.ts'
import type { AtivoCliente, ClienteStore, ConexaoCliente } from '../../supabase/functions/marketing-hub/clientes.ts'
import { limparCacheGoogle } from '../../supabase/functions/_shared/marketing/google-auth.ts'
import {
  type StatePayload,
  OauthErro,
  assinarState,
  lerState,
  pkceChallenge,
  pkceVerifier,
  urlConsentimentoGoogle,
  urlConsentimentoMeta,
} from '../../supabase/functions/_shared/marketing/oauth-cliente.ts'

// Fixtures: nenhum valor aqui é credencial real.
const AGORA = new Date('2026-10-21T15:00:00Z')
const SEGREDO = 'fixture-state-secret-com-mais-de-32-caracteres'
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
  'cliente-a': { userId: USER_A, role: 'CLIENT', aal: 'aal1', banido: false },
  'cliente-b': { userId: USER_B, role: 'CLIENT', aal: 'aal1', banido: false },
  'cliente-a-banido': { userId: USER_A, role: 'CLIENT', aal: 'aal1', banido: true },
  'admin-aal2': { userId: ADMIN, role: 'NO_ADMIN', aal: 'aal2', banido: false },
  'admin-aal1': { userId: ADMIN, role: 'NO_ADMIN', aal: 'aal1', banido: false },
  dot: { userId: DOT, role: 'MARKETING_AGENT', aal: 'aal1', banido: false },
}
const MEMBROS: Record<string, string> = { [USER_A]: CLI_A, [USER_B]: CLI_B }

function clienteStoreEmMemoria() {
  const nonces = new Map<string, string>()
  const conexoes = new Map<string, ConexaoCliente & { token: string | null; usuario: string | null }>()
  const ativos = new Map<string, AtivoCliente[]>()
  const eventos: { clientId: string; provedor: string; evento: string }[] = []
  const k = (c: string, p: string) => `${c}:${p}`
  const store: ClienteStore = {
    async clienteAutorizado(userId, clientId) { return MEMBROS[userId] === clientId },
    async nonceRegistrar(n, exp) { nonces.set(n, exp) },
    async nonceConsumir(n) {
      const exp = nonces.get(n)
      nonces.delete(n)
      return Boolean(exp && exp > AGORA.toISOString())
    },
    async conexaoSalvar(l) {
      conexoes.set(k(l.clientId, l.provedor), {
        provedor: l.provedor, estado: 'conectado', escopos: l.escopos, expira_em: l.expiraEm, conectado_em: AGORA.toISOString(),
        atualizado_em: AGORA.toISOString(), ultimo_erro: null, token: l.token, usuario: l.usuarioExterno,
      })
      eventos.push({ clientId: l.clientId, provedor: l.provedor, evento: 'conectou' })
    },
    async tokenLer(c, p) {
      const x = conexoes.get(k(c, p))
      return x?.estado === 'conectado' && x.token ? { token: x.token, escopos: x.escopos } : null
    },
    async conexoesListar(c) {
      return [...conexoes.entries()].filter(([key]) => key.startsWith(`${c}:`)).map(([, v]) => ({
        provedor: v.provedor, estado: v.estado, escopos: v.escopos, expira_em: v.expira_em,
        conectado_em: v.conectado_em, atualizado_em: v.atualizado_em, ultimo_erro: v.ultimo_erro,
      }))
    },
    async conexaoMarcar(c, p, estado, erro) {
      const x = conexoes.get(k(c, p))
      if (x?.estado === 'conectado') Object.assign(x, { estado, ultimo_erro: erro })
    },
    async conexaoRevogar(c, p) {
      const x = conexoes.get(k(c, p))
      if (x) Object.assign(x, { estado: 'revogado', token: null, escopos: [] })
      ativos.set(c, (ativos.get(c) ?? []).filter((a) => (p === 'meta' ? a.tipo !== 'meta_ads' : a.tipo === 'meta_ads')))
    },
    async ativosListar(c) { return ativos.get(c) ?? [] },
    async ativosSalvar(c, _p, novos) {
      const atuais = (ativos.get(c) ?? []).filter((a) => !novos.some((n) => n.tipo === a.tipo))
      ativos.set(c, [...atuais, ...novos])
    },
  }
  return { store, nonces, conexoes, ativos, eventos }
}

function storeHub(): MarketingStore & { cache: Map<string, unknown> } {
  const cache = new Map<string, unknown>()
  const nao = async () => { throw new Error('não usado') }
  return {
    cache,
    async cacheLer(c) { return cache.get(c) ?? null },
    async cacheGravar(c, v) { cache.set(c, v) },
    async cacheLimpar(p) { for (const c of [...cache.keys()]) if (c.startsWith(p)) cache.delete(c) },
    async agentePapel(id) { return id === ADMIN ? 'NO_ADMIN' : id === DOT ? 'MARKETING_AGENT' : 'CLIENT' },
    async ativos() { return { clientId: 'cli-no', metaAds: { id: 'x', externalId: 'act_999' }, metaPage: null, metaInstagram: null } },
    acaoIniciar: nao, acaoFinalizar: nao, acoesListar: nao, escritasOk: async () => [], postsListar: nao, postInserir: nao,
    postBuscar: nao, postAtualizar: nao, postsReservarVencidos: nao, leadsOrigem: async () => [], leadsListar: nao, leadExiste: nao,
    leadClassificar: nao, cronSecretOk: async () => false, urlUpload: nao, urlLeitura: nao, baixarMidia: nao, agentesListar: nao,
    agenteConvidar: nao, agenteBanir: nao,
  } as MarketingStore & { cache: Map<string, unknown> }
}

const HUB = 'https://x.supabase.co/functions/v1/marketing-hub'
const RETRO = 'https://www.notechstack.com.br/agentes/auditor/retrospectiva/'

const CONFIG: HubConfig = {
  metaToken: TOKEN_ADMIN_META,
  google: { clientId: 'fixture-google-client', clientSecret: 'fixture-google-secret', refreshToken: 'fixture-refresh-admin', developerToken: null, customerId: null, loginCustomerId: null, ga4PropertyId: null, gscSiteUrl: null },
  googleCriacaoLiberada: false,
  appUrl: 'https://app.notechstack.com.br',
  clientes: { stateSecret: SEGREDO, hubUrl: HUB, retroUrl: RETRO, meta: { appId: '424242', appSecret: 'fixture-meta-secret', configId: 'cfg-77' } },
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
      headers: { origin: 'https://www.notechstack.com.br', ...(sessao ? { authorization: `Bearer ${sessao}` } : {}), ...(corpo ? { 'content-type': 'application/json' } : {}), ...extra },
      body: corpo ? JSON.stringify(corpo) : undefined,
    }))
    return { status: resp.status, body: await resp.json().catch(() => null), headers: resp.headers }
  }
  return { ...cli, hub, chamar, logs }
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
  const r = await m.chamar('POST', `/cliente/${provedor}/conectar`, sessao, { client_id: clientId })
  expect(r.status).toBe(200)
  const ir = new URL(r.body.url)
  const viaIr = await m.chamar('GET', `${ir.pathname.replace('/functions/v1/marketing-hub', '')}${ir.search}`)
  expect(viaIr.status).toBe(303)
  const cookie = (viaIr.headers.get('set-cookie') ?? '').split(';')[0]
  return { state: ir.searchParams.get('state')!, cookie, destino: new URL(viaIr.headers.get('location')!) }
}

const voltaDe = (r: { headers: Headers }) => new URL(r.headers.get('location')!)

// ---------------------------------------------------------------------------

describe('oauth-cliente — state assinado e PKCE', () => {
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
      const outro = Buffer.from(JSON.stringify({ ...payload, c: CLI_B })).toString('base64url')
      return `${v}.${outro}.${sig}`
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
    const semConfig = new URL(urlConsentimentoMeta({ ...base, configId: null }))
    expect(semConfig.searchParams.get('scope')).toBe('ads_read')
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
})

describe('/cliente — quem pode conectar', () => {
  it.each([
    [undefined, CLI_A, 401, 'UNAUTHENTICATED'],
    ['cliente-a-banido', CLI_A, 401, 'UNAUTHENTICATED'],
    ['cliente-a', CLI_B, 403, 'FORBIDDEN'],
    ['cliente-b', CLI_A, 403, 'FORBIDDEN'],
    ['cliente-a', '33333333-3333-4333-8333-333333333333', 403, 'FORBIDDEN'],
    ['dot', CLI_A, 403, 'FORBIDDEN'],
    ['admin-aal1', CLI_A, 403, 'MFA_REQUIRED'],
    ['cliente-a', 'nao-e-uuid', 422, 'INVALID_REQUEST'],
  ])('sessão %s no cliente %s recebe %i', async (sessao, clientId, status, codigo) => {
    const m = montar()
    const r = await m.chamar('POST', '/cliente/meta/conectar', sessao, { client_id: clientId })
    expect(r.status).toBe(status)
    expect(r.body.error_code).toBe(codigo)
    expect(m.nonces.size).toBe(0)
  })

  it('membro do cliente e NO_ADMIN aal2 recebem a URL de /ir', async () => {
    const m = montar()
    for (const sessao of ['cliente-a', 'admin-aal2']) {
      const r = await m.chamar('POST', '/cliente/google/conectar', sessao, { client_id: CLI_A })
      expect(r.status).toBe(200)
      expect(r.body.url).toMatch(new RegExp(`^${HUB}/cliente/google/ir\\?state=v1\\.`))
      expect(r.headers.get('cache-control')).toBe('no-store')
    }
  })

  it('sem segredo de state (ou curto demais) responde 503 e não cria nonce', async () => {
    for (const stateSecret of [null, 'curto']) {
      const m = montar({ clientes: { ...CONFIG.clientes!, stateSecret } })
      const r = await m.chamar('POST', '/cliente/meta/conectar', 'cliente-a', { client_id: CLI_A })
      expect(r.status).toBe(503)
      expect(m.nonces.size).toBe(0)
    }
  })

  it('o cliente continua sem acesso às rotas do admin (/overview segue 403)', async () => {
    const m = montar()
    const r = await m.chamar('GET', '/overview?periodo=7d', 'cliente-a')
    expect(r.status).toBe(403)
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

  it('volta ok: troca com code_verifier, guarda o token longo e volta à retrospectiva', async () => {
    const m = montar()
    const { state, cookie } = await iniciar(m, 'meta')
    const chamadas = mockFetch((c) => metaOk(c))
    const r = await m.chamar('GET', `/cliente/meta/callback?code=CODE1&state=${state}`, undefined, undefined, { cookie })
    expect(r.status).toBe(303)
    const volta = voltaDe(r)
    expect(`${volta.origin}${volta.pathname}`).toBe(RETRO)
    expect(volta.searchParams.get('resultado')).toBe('ok')
    expect(volta.searchParams.get('conexao')).toBe('meta')
    expect(r.headers.get('set-cookie')).toContain('Max-Age=0')

    const s = await lerState(SEGREDO, state, AGORA.getTime())
    const troca = chamadas.find((c) => c.url.searchParams.get('code') === 'CODE1')!
    expect(troca.url.searchParams.get('code_verifier')).toBe(await pkceVerifier(SEGREDO, s.n))
    expect(troca.url.searchParams.get('redirect_uri')).toBe(`${HUB}/cliente/meta/callback`)

    const salvo = m.conexoes.get(`${CLI_A}:meta`)!
    expect(salvo.token).toBe(TOKEN_META_LONGO)
    expect(salvo.escopos).toContain('ads_read')
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

  it('quem perdeu o acesso ao cliente durante o consentimento não conecta', async () => {
    const m = montar()
    const { state, cookie } = await iniciar(m, 'meta')
    const antes = MEMBROS[USER_A]
    MEMBROS[USER_A] = CLI_B
    try {
      mockFetch((c) => metaOk(c))
      const r = await m.chamar('GET', `/cliente/meta/callback?code=C&state=${state}`, undefined, undefined, { cookie })
      expect(voltaDe(r).searchParams.get('motivo')).toBe('state_invalido')
      expect(m.conexoes.size).toBe(0)
    } finally {
      MEMBROS[USER_A] = antes
    }
  })
})

const ESCOPOS_GOOGLE = 'https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/webmasters.readonly'

function googleOk(c: Chamada): Resposta | undefined {
  if (c.url.href === 'https://oauth2.googleapis.com/token') {
    const b = c.body as Record<string, string>
    if (b.grant_type === 'authorization_code') return { body: { refresh_token: REFRESH_GOOGLE, access_token: 'x', scope: ESCOPOS_GOOGLE } }
    if (b.grant_type === 'refresh_token' && b.refresh_token === REFRESH_GOOGLE) return { body: { access_token: ACCESS_GOOGLE, expires_in: 3600 } }
    return { status: 400, body: { error: 'invalid_grant' } }
  }
  return undefined
}

describe('/cliente/google — ida e volta', () => {
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

async function conectado(m: ReturnType<typeof montar>, provedor: 'meta' | 'google', escopos = provedor === 'meta' ? ['ads_read'] : ESCOPOS_GOOGLE.split(' ')) {
  await m.store.conexaoSalvar({ clientId: CLI_A, provedor, token: provedor === 'meta' ? TOKEN_META_LONGO : REFRESH_GOOGLE, escopos, expiraEm: null, usuarioExterno: null, userId: USER_A })
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
    const r = await m.chamar('GET', `/cliente/meta/contas?client_id=${CLI_A}`, 'cliente-a')
    expect(r.status).toBe(200)
    expect(r.body.meta_ads.map((c: { external_id: string }) => c.external_id)).toEqual(['act_123', 'act_456'])
    expect(r.body.meta_ads[1].detalhe).toContain('inativa')
    expect(chamadas.every((c) => c.url.searchParams.get('access_token') === TOKEN_META_LONGO)).toBe(true)
  })

  it('Google: customers diretos e filhos de MCC, propriedades GA4 e sites verificados', async () => {
    const m = montar()
    await conectado(m, 'google')
    const chamadas = mockFetch(contasGoogle)
    const r = await m.chamar('GET', `/cliente/google/contas?client_id=${CLI_A}`, 'cliente-a')
    expect(r.status).toBe(200)
    expect(r.body.google_ads).toEqual([
      expect.objectContaining({ external_id: '1112223333', login_customer_id: null }),
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
    const r = await m.chamar('GET', `/cliente/google/contas?client_id=${CLI_A}`, 'cliente-a')
    expect(r.body).toMatchObject({ google_ads: null, gsc: null })
    expect(chamadas.some((c) => c.url.host === 'googleads.googleapis.com')).toBe(false)
  })

  it('sem conexão responde 409 NAO_CONECTADO', async () => {
    const m = montar()
    const r = await m.chamar('GET', `/cliente/meta/contas?client_id=${CLI_A}`, 'cliente-a')
    expect(r.status).toBe(409)
  })

  it('grava só o que o token lista agora; id fora da lista é 422', async () => {
    const m = montar()
    await conectado(m, 'google')
    mockFetch(contasGoogle)
    const ok = await m.chamar('POST', '/cliente/google/contas', 'cliente-a', {
      client_id: CLI_A, google_ads: { customer_id: '5556667777', login_customer_id: '9998887777' }, ga4: '321', gsc: 'sc-domain:lojaa.com.br',
    })
    expect(ok.status).toBe(200)
    expect(m.ativos.get(CLI_A)).toHaveLength(3)
    const fora = await m.chamar('POST', '/cliente/google/contas', 'cliente-a', { client_id: CLI_A, ga4: '999' })
    expect(fora.status).toBe(422)
    expect(fora.body).toMatchObject({ error_code: 'CONTA_NAO_DISPONIVEL', campos: ['ga4'] })
    const mccErrada = await m.chamar('POST', '/cliente/google/contas', 'cliente-a', { client_id: CLI_A, google_ads: { customer_id: '5556667777' } })
    expect(mccErrada.status).toBe(422)
  })

  it('cliente B não lista nem grava contas do cliente A', async () => {
    const m = montar()
    await conectado(m, 'meta')
    const chamadas = mockFetch(contasMeta)
    expect((await m.chamar('GET', `/cliente/meta/contas?client_id=${CLI_A}`, 'cliente-b')).status).toBe(403)
    expect((await m.chamar('POST', '/cliente/meta/contas', 'cliente-b', { client_id: CLI_A, meta_ads: 'act_123' })).status).toBe(403)
    expect((await m.chamar('GET', `/cliente/conexoes?client_id=${CLI_A}`, 'cliente-b')).status).toBe(403)
    expect((await m.chamar('GET', `/cliente/overview?client_id=${CLI_A}&periodo=7d`, 'cliente-b')).status).toBe(403)
    expect(chamadas).toHaveLength(0)
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

  it('overview lê Meta e GA4 do cliente reaproveitando os adaptadores; o token da Nó nunca sai', async () => {
    const m = montar()
    await conectado(m, 'meta')
    await conectado(m, 'google')
    m.ativos.set(CLI_A, [
      { tipo: 'meta_ads', external_id: 'act_123', nome: null, login_customer_id: null },
      { tipo: 'ga4', external_id: '321', nome: null, login_customer_id: null },
    ])
    const chamadas = mockFetch(plataformas)
    const r = await m.chamar('GET', `/cliente/overview?client_id=${CLI_A}&periodo=7d`, 'cliente-a')
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
    // Cache separado por cliente: nada do admin é reaproveitado e vice-versa.
    expect([...m.hub.cache.keys()].every((k) => k.startsWith(`cliente:${CLI_A}:`))).toBe(true)
  })

  it('Meta 190 marca a conexão como expirada', async () => {
    const m = montar()
    await conectado(m, 'meta')
    m.ativos.set(CLI_A, [{ tipo: 'meta_ads', external_id: 'act_123', nome: null, login_customer_id: null }])
    mockFetch(() => ({ status: 400, body: { error: { message: 'Error validating access token', type: 'OAuthException', code: 190 } } }))
    const r = await m.chamar('GET', `/cliente/overview?client_id=${CLI_A}&periodo=7d`, 'cliente-a')
    expect(r.body.blocos.meta_ads.ok).toBe(false)
    expect(m.conexoes.get(`${CLI_A}:meta`)!.estado).toBe('expirado')
    const c = await m.chamar('GET', `/cliente/conexoes?client_id=${CLI_A}`, 'cliente-a')
    expect(c.body.conexoes.meta.estado).toBe('expirado')
  })

  it('Google invalid_grant marca a conexão como expirada', async () => {
    const m = montar()
    await m.store.conexaoSalvar({ clientId: CLI_A, provedor: 'google', token: 'refresh-morto', escopos: ESCOPOS_GOOGLE.split(' '), expiraEm: null, usuarioExterno: null, userId: USER_A })
    m.ativos.set(CLI_A, [{ tipo: 'ga4', external_id: '321', nome: null, login_customer_id: null }])
    mockFetch(googleOk)
    await m.chamar('GET', `/cliente/overview?client_id=${CLI_A}&periodo=7d`, 'cliente-a')
    expect(m.conexoes.get(`${CLI_A}:google`)!.estado).toBe('expirado')
  })

  it('/conexoes mostra expirado quando o token longo da Meta passou da validade', async () => {
    const m = montar()
    await m.store.conexaoSalvar({ clientId: CLI_A, provedor: 'meta', token: TOKEN_META_LONGO, escopos: ['ads_read'], expiraEm: '2026-10-20T00:00:00Z', usuarioExterno: null, userId: USER_A })
    const r = await m.chamar('GET', `/cliente/conexoes?client_id=${CLI_A}`, 'cliente-a')
    expect(r.body.conexoes.meta.estado).toBe('expirado')
    expect(r.body.conexoes.google.estado).toBe('desconectado')
    expect(JSON.stringify(r.body)).not.toContain(TOKEN_META_LONGO)
  })
})

describe('/cliente — revogação', () => {
  it('revoga no provedor com o token do cliente e apaga do Vault', async () => {
    const m = montar()
    await conectado(m, 'meta')
    const chamadas = mockFetch((c) => (c.method === 'DELETE' && c.url.pathname.endsWith('/me/permissions') ? { body: { success: true } } : undefined))
    const r = await m.chamar('POST', '/cliente/meta/revogar', 'cliente-a', { client_id: CLI_A })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ estado: 'revogado', revogado_no_provedor: true })
    expect(chamadas[0].url.searchParams.get('access_token')).toBe(TOKEN_META_LONGO)
    expect(await m.store.tokenLer(CLI_A, 'meta')).toBeNull()
  })

  it('Google: revoga o refresh token; falha no provedor não impede apagar do Vault', async () => {
    const m = montar()
    await conectado(m, 'google')
    const chamadas = mockFetch(() => ({ status: 400, body: { error: 'invalid_token' } }))
    const r = await m.chamar('POST', '/cliente/google/revogar', 'cliente-a', { client_id: CLI_A })
    expect(r.body).toMatchObject({ estado: 'revogado', revogado_no_provedor: false })
    expect(chamadas[0].url.href).toBe('https://oauth2.googleapis.com/revoke')
    expect(chamadas[0].body).toEqual({ token: REFRESH_GOOGLE })
    expect(await m.store.tokenLer(CLI_A, 'google')).toBeNull()
  })

  it('cliente B não revoga a conexão do cliente A', async () => {
    const m = montar()
    await conectado(m, 'meta')
    const r = await m.chamar('POST', '/cliente/meta/revogar', 'cliente-b', { client_id: CLI_A })
    expect(r.status).toBe(403)
    expect(await m.store.tokenLer(CLI_A, 'meta')).not.toBeNull()
  })
})
