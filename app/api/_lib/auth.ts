// Autenticação da API por `x-api-key` (critério 23). O Nó guarda só o sha256 hex da chave
// (`fiscal_tenants.api_key_hash`, critério 28); a busca é pelo hash, nunca pela chave.
import { createHash, timingSafeEqual } from 'node:crypto'
import type { Queryable } from './db.js'

export type AuthenticatedTenant = { id: string; active: boolean }

export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex')
}

export async function findTenantByApiKey(db: Queryable, apiKey: string | null): Promise<AuthenticatedTenant | null> {
  if (!apiKey) return null
  const { rows } = await db.query<AuthenticatedTenant>(
    'select id, active from nofiscal.fiscal_tenants where api_key_hash = $1',
    [hashApiKey(apiKey)],
  )
  return rows[0] ?? null
}

/** Compara `Authorization: Bearer <segredo>` em tempo constante. Sem segredo configurado, nega. */
export function bearerMatches(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header) return false
  const expected = Buffer.from(`Bearer ${secret}`, 'utf8')
  const received = Buffer.from(header, 'utf8')
  return expected.length === received.length && timingSafeEqual(expected, received)
}
