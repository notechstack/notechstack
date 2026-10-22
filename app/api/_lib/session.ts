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

export function supabaseSessionVerifier(options: { url: string; anonKey: string; fetch?: FetchLike }): SessionVerifier {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init))
  const endpoint = `${options.url.replace(/\/+$/, '')}/auth/v1/user`
  return {
    async userIdFrom(request) {
      const header = request.headers.get('authorization')
      const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null
      if (!match) return null
      const response = await doFetch(endpoint, {
        method: 'GET',
        headers: { apikey: options.anonKey, authorization: `Bearer ${match[1]}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) return null
      const user = (await response.json().catch(() => null)) as { id?: unknown } | null
      return typeof user?.id === 'string' && UUID.test(user.id) ? user.id : null
    },
  }
}

export function sessionVerifierFromEnv(): SessionVerifier {
  const url = process.env.SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY
  if (!url || !anonKey) throw new Error('SUPABASE_URL ou SUPABASE_ANON_KEY não configurada')
  return supabaseSessionVerifier({ url, anonKey })
}
