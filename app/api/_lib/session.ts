// Sessão Supabase do site (Landing de .checks/agente-fiscal-whatsapp.md, lote A - rota do
// certificado): `Authorization: Bearer <access_token>` conferido em
// `GET ${SUPABASE_URL}/auth/v1/user` com `apikey: ${SUPABASE_ANON_KEY}`, como o
// `auth.getUser(token)` das edge functions. O token nunca é logado.
export interface SessionVerifier {
  /** Id do usuário da sessão, ou `null` sem sessão válida. */
  userIdFrom(request: Request): Promise<string | null>
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<Response>

const REQUEST_TIMEOUT_MS = 5_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type UsuarioDaSessao = { token: string; user: { id?: unknown; app_metadata?: { role?: unknown } } }

function usuarioDaSessao(options: { url: string; anonKey: string; fetch?: FetchLike }) {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init))
  const endpoint = `${options.url.replace(/\/+$/, '')}/auth/v1/user`
  return async (request: Request): Promise<UsuarioDaSessao | null> => {
    const header = request.headers.get('authorization')
    const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null
    if (!match) return null
    const response = await doFetch(endpoint, {
      method: 'GET',
      headers: { apikey: options.anonKey, authorization: `Bearer ${match[1]}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const user = (await response.json().catch(() => null)) as UsuarioDaSessao['user'] | null
    return user && typeof user.id === 'string' && UUID.test(user.id) ? { token: match[1], user } : null
  }
}

export function supabaseSessionVerifier(options: { url: string; anonKey: string; fetch?: FetchLike }): SessionVerifier {
  const usuario = usuarioDaSessao(options)
  return {
    async userIdFrom(request) {
      return ((await usuario(request))?.user.id as string | undefined) ?? null
    },
  }
}

export function sessionVerifierFromEnv(): SessionVerifier {
  const url = process.env.SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY
  if (!url || !anonKey) throw new Error('SUPABASE_URL ou SUPABASE_ANON_KEY não configurada')
  return supabaseSessionVerifier({ url, anonKey })
}

/** Administrador da Nó com segundo fator: o mesmo que `RoleRoute roles={['NO_ADMIN']} requireAal2` exige na tela. */
export interface AdminVerifier {
  /** Id do administrador, ou `null` sem sessão válida, sem `NO_ADMIN` ou sem `aal2`. */
  adminIdFrom(request: Request): Promise<string | null>
}

/** Claims do JWT já conferido pelo Auth (o `aal` e o `sub` só existem no token). */
function claimsDoToken(token: string): { sub?: unknown; aal?: unknown } | null {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { sub?: unknown; aal?: unknown }
  } catch {
    return null
  }
}

/**
 * O papel vem de `app_metadata.role` do usuário que o Auth devolve; o nível de garantia, do claim `aal` do
 * próprio token, que o Auth acabou de aceitar em `/auth/v1/user` (e cujo `sub` tem de ser o mesmo usuário).
 */
export function supabaseAdminVerifier(options: { url: string; anonKey: string; fetch?: FetchLike }): AdminVerifier {
  const usuario = usuarioDaSessao(options)
  return {
    async adminIdFrom(request) {
      const sessao = await usuario(request)
      if (!sessao || sessao.user.app_metadata?.role !== 'NO_ADMIN') return null
      const claims = claimsDoToken(sessao.token)
      return claims?.aal === 'aal2' && claims.sub === sessao.user.id ? (sessao.user.id as string) : null
    },
  }
}

export function adminVerifierFromEnv(): AdminVerifier {
  const url = process.env.SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY
  if (!url || !anonKey) throw new Error('SUPABASE_URL ou SUPABASE_ANON_KEY não configurada')
  return supabaseAdminVerifier({ url, anonKey })
}
