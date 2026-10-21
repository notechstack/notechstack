// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { criarHandler, type Chamador, type MarketingStore } from '../../supabase/functions/marketing-hub/handler.ts'
import { GOOGLE_CALLBACK, GOOGLE_ESCOPOS } from '../../supabase/functions/_shared/marketing/google-oauth.ts'
import { limparCacheGoogle } from '../../supabase/functions/_shared/marketing/google-auth.ts'

const admin: Chamador = { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'NO_ADMIN', aal: 'aal2', banido: false }
const host = 'https://untrusted.example/marketing-hub'
function montar(ch: Chamador | null = admin, hubUrl?: string) {
  let clock = Date.parse('2026-10-01T12:00:00Z')
  const states = new Map<string, { value: { user_id: string }; until: number }>()
  let vault: string | null = null
  const audit: unknown[] = []
  const store = {
    escritasOk: vi.fn(async () => true),
    leadsListar: vi.fn(async () => []),
    leadExiste: vi.fn(async () => false),
    leadClassificar: vi.fn(async () => {}),
    cacheGravar: vi.fn(async (key: string, value: { user_id: string }, ttl: number) => { states.set(key, { value, until: clock + ttl * 1000 }) }),
    googleStateConsumir: vi.fn(async (state: string) => {
      const key = `google_oauth_state:${state}`, row = states.get(key)
      states.delete(key)
      return row && row.until > clock ? row.value : null
    }),
    googleConexaoSalvar: vi.fn(async (userId: string, refreshToken: string, requestId: string) => {
      vault = refreshToken
      audit.push({ request_id: requestId, actor_user_id: userId, actor_role: 'NO_ADMIN', kind: 'google.conectar', payload: {}, result: { conectado: true } })
    }),
    googleRefreshLer: vi.fn(async () => vault),
    cacheLimpar: vi.fn(async () => {}),
    cacheLer: vi.fn(async () => null),
    ativos: vi.fn(async () => ({ clientId: null, metaAds: null, metaPage: null, metaInstagram: null })),
    leadsOrigem: vi.fn(async () => []),
  }
  const log = vi.fn()
  const handler = criarHandler({ store: store as unknown as MarketingStore, autenticar: async () => ch,
    config: { metaToken: null, googleCriacaoLiberada: false, appUrl: 'https://app.notechstack.com.br', google: {
      clientId: 'client-test', clientSecret: 'secret-fixture', refreshToken: 'fallback-fixture',
      developerToken: null, customerId: null, loginCustomerId: null, ga4PropertyId: '123', gscSiteUrl: null,
    }, ...(hubUrl ? { clientes: { stateSecret: null, hubUrl, voltaUrl: 'https://app.notechstack.com.br/auditor/{client_id}/conexoes', meta: { appId: null, appSecret: null, configId: null } } } : {}),
    }, agora: () => new Date(clock), esperar: async () => {}, uuid: () => crypto.randomUUID(), log })
  const call = (path: string, method = 'GET') => handler(new Request(`${host}/${path}`, {
    method, headers: method === 'POST' ? { authorization: 'Bearer session-test' } : {},
  }))
  const connect = async () => {
    const result = await call('google/connect', 'POST')
    return { result, url: new URL((await result.json()).url) }
  }
  return { store, audit, states, log, call, connect, advance: (ms: number) => { clock += ms }, vault: () => vault }
}
afterEach(() => { vi.unstubAllGlobals(); limparCacheGoogle() })

describe('Google OAuth T1', () => {
  it('base pública /hub (proxy do app): consentimento e troca usam a mesma callback; sem ela, a do supabase.co', async () => {
    const hub = montar(admin, 'https://app.notechstack.com.br/hub')
    const remote = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ refresh_token: 'vault-fixture', scope: GOOGLE_ESCOPOS.join(' ') }))
    vi.stubGlobal('fetch', remote)
    const { url } = await hub.connect()
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.notechstack.com.br/hub/google/callback')
    await hub.call(`google/callback?state=${url.searchParams.get('state')}&code=code-fixture`)
    expect(new URLSearchParams(remote.mock.calls[0][1]?.body as string).get('redirect_uri')).toBe('https://app.notechstack.com.br/hub/google/callback')
    const padrao = montar(admin, 'https://sdeowbqmwkwseyktyemn.supabase.co/functions/v1/marketing-hub')
    expect((await padrao.connect()).url.searchParams.get('redirect_uri')).toBe(GOOGLE_CALLBACK)
  })
  it('17 pede exatamente três escopos offline e consent, state 32 bytes TTL 600 e callback fixo', async () => {
    const m = montar(), { result, url } = await m.connect()
    expect(result.status).toBe(200)
    expect(result.headers.get('cache-control')).toBe('no-store')
    expect(url.origin).toBe('https://accounts.google.com')
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([
      'https://www.googleapis.com/auth/adwords',
      'https://www.googleapis.com/auth/analytics.readonly',
      'https://www.googleapis.com/auth/webmasters.readonly',
    ])
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('redirect_uri')).toBe(GOOGLE_CALLBACK)
    expect(url.searchParams.get('state')).toMatch(/^[a-f0-9]{64}$/)
    expect(m.store.cacheGravar).toHaveBeenCalledWith(expect.any(String), { user_id: admin.userId }, 600)
  })
  it.each(['ausente', 'desconhecido', 'expirado', 'limite-600'])('18 state %s não troca código nem grava Vault', async kind => {
    const m = montar(), remote = vi.fn()
    vi.stubGlobal('fetch', remote)
    const { url } = await m.connect()
    let state = url.searchParams.get('state')!
    if (kind === 'ausente') state = ''
    if (kind === 'desconhecido') state = 'b'.repeat(64)
    if (kind === 'expirado') m.advance(601000)
    if (kind === 'limite-600') m.advance(600000)
    const response = await m.call(`google/callback?state=${state}&code=code-fixture`)
    expect(response.headers.get('location')).toBe('https://app.notechstack.com.br/no/marketing/conexoes?google=erro&motivo=state_invalido')
    expect(remote).not.toHaveBeenCalled()
    expect(m.store.googleConexaoSalvar).not.toHaveBeenCalled()
  })
  it('17/18/21/22 callback concorrente troca uma vez, salva uma conexão e retorna sem segredos', async () => {
    const m = montar(), remote = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ refresh_token: 'vault-fixture', scope: GOOGLE_ESCOPOS.join(' ') }))
    vi.stubGlobal('fetch', remote)
    const { url } = await m.connect(), state = url.searchParams.get('state')
    const responses = await Promise.all([m.call(`google/callback?state=${state}&code=code-fixture`), m.call(`google/callback?state=${state}&code=code-fixture`)])
    expect(remote).toHaveBeenCalledTimes(1)
    expect(new URLSearchParams(remote.mock.calls[0][1]?.body as string).get('redirect_uri')).toBe(GOOGLE_CALLBACK)
    expect(responses.map(r => r.headers.get('location'))).toEqual([
      'https://app.notechstack.com.br/no/marketing/conexoes?google=ok',
      'https://app.notechstack.com.br/no/marketing/conexoes?google=erro&motivo=state_invalido',
    ])
    expect(m.store.googleConexaoSalvar).toHaveBeenCalledTimes(1)
    expect(m.audit).toHaveLength(1)
    expect(m.audit[0]).toMatchObject({ kind: 'google.conectar', actor_role: 'NO_ADMIN' })
    expect(m.vault()).toBe('vault-fixture')
    expect(JSON.stringify([m.audit, [...m.states], m.log.mock.calls])).not.toContain('vault-fixture')
    for (const response of responses) {
      expect(await response.text()).toBe('')
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    }
    expect(m.store.cacheLimpar).toHaveBeenCalledWith('connections:')
    expect(m.store.cacheLimpar).toHaveBeenCalledWith('conexoes')
  })
  it.each(['access_denied', 'http-error', 'network-error', 'no-refresh', 'partial-scopes'])('19 %s preserva conexão anterior e consome state', async kind => {
    const m = montar()
    await m.store.googleConexaoSalvar(admin.userId, 'previous-fixture', 'previous-id')
    m.store.googleConexaoSalvar.mockClear()
    const remote = vi.fn(async () => {
      if (kind === 'network-error') throw new Error('secret-fixture')
      return Response.json({ refresh_token: kind === 'no-refresh' ? undefined : 'new-fixture', scope: kind === 'partial-scopes' ? GOOGLE_ESCOPOS[0] : GOOGLE_ESCOPOS.join(' '), error: 'secret-fixture' }, { status: kind === 'http-error' ? 400 : 200 })
    })
    vi.stubGlobal('fetch', remote)
    const { url } = await m.connect(), state = url.searchParams.get('state')
    const response = await m.call(`google/callback?state=${state}&${kind === 'access_denied' ? 'error=access_denied' : 'code=code-fixture'}`)
    expect(response.headers.get('location')).toContain(`motivo=${kind === 'access_denied' ? 'access_denied' : 'troca_falhou'}`)
    expect(m.vault()).toBe('previous-fixture')
    expect(m.store.googleConexaoSalvar).not.toHaveBeenCalled()
    expect(m.log).not.toHaveBeenCalled()
    expect((await m.call(`google/callback?state=${state}&code=code-fixture`)).headers.get('location')).toContain('state_invalido')
    if (kind === 'access_denied') expect(remote).not.toHaveBeenCalled()
  })
  it.each([
    ['dot', { ...admin, role: 'MARKETING_AGENT' }, 403, 'FORBIDDEN'],
    ['aal1', { ...admin, aal: 'aal1' }, 403, 'MFA_REQUIRED'],
    ['banido', { ...admin, banido: true }, 401, 'UNAUTHENTICATED'],
    ['anônimo', null, 401, 'UNAUTHENTICATED'],
  ] as const)('20 %s não inicia consentimento', async (_, ch, status, error) => {
    const m = montar(ch), response = await m.call('google/connect', 'POST')
    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ error_code: error })
    expect(m.store.cacheGravar).not.toHaveBeenCalled()
  })
  it.each([true, false])('21 leitura usa Vault antes do fallback (Vault preenchido: %s)', async filled => {
    const m = montar()
    if (filled) await m.store.googleConexaoSalvar(admin.userId, 'vault-fixture', 'previous-id')
    const remote = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ access_token: 'access-fixture', expires_in: 3600 }))
    vi.stubGlobal('fetch', remote)
    // GET autenticado para atravessar o handler completo.
    const response = await criarLeitura(m)
    expect(response.status).toBe(200)
    expect(remote).toHaveBeenCalled()
    const tokenCall = remote.mock.calls.find(([url]) => url === 'https://oauth2.googleapis.com/token')!
    expect(new URLSearchParams(tokenCall[1]?.body as string).get('refresh_token')).toBe(filled ? 'vault-fixture' : 'fallback-fixture')
  })
  it('21 falha do Vault não usa secret de reserva nem chama Google', async () => {
    const m = montar(), remote = vi.fn()
    m.store.googleRefreshLer.mockRejectedValue(new Error('Vault indisponível'))
    vi.stubGlobal('fetch', remote)
    const response = await criarLeitura(m)
    expect((await response.json()).blocos.ga4.ok).toBe(false)
    expect(remote).not.toHaveBeenCalled()
  })
  it('19 falha no salvamento devolve erro fixo sem mensagem sensível', async () => {
    const m = montar()
    m.store.googleConexaoSalvar.mockRejectedValue(new Error('secret-fixture'))
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ refresh_token: 'vault-fixture', scope: GOOGLE_ESCOPOS.join(' ') })))
    const { url } = await m.connect()
    const response = await m.call(`google/callback?state=${url.searchParams.get('state')}&code=code-fixture`)
    expect(response.headers.get('location')).toContain('motivo=troca_falhou')
    expect(m.log).not.toHaveBeenCalled()
    expect(m.vault()).toBe(null)
  })
})

async function criarLeitura(m: ReturnType<typeof montar>) {
  // O helper usa POST para autenticar; esta requisição mantém GET e a mesma dependência.
  const h = criarHandler({ store: m.store as unknown as MarketingStore, autenticar: async () => admin,
    config: { metaToken: null, googleCriacaoLiberada: false, appUrl: 'https://app.notechstack.com.br', google: {
      clientId: 'client-test', clientSecret: 'secret-fixture', refreshToken: 'fallback-fixture', developerToken: null,
      customerId: null, loginCustomerId: null, ga4PropertyId: '123', gscSiteUrl: null,
    } }, agora: () => new Date('2026-10-01T12:00:00Z'), esperar: async () => {}, uuid: () => crypto.randomUUID(), log: m.log })
  return h(new Request(`${host}/overview?periodo=7d&fresco=1`, { headers: { authorization: 'Bearer session-test' } }))
}
