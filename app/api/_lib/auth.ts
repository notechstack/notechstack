// Autenticação da API por `x-api-key` (critério 23). O Nó guarda só o sha256 hex da chave
// (`fiscal_tenants.api_key_hash`, critério 28); a busca é pelo hash, nunca pela chave.
import { createHash, timingSafeEqual } from 'node:crypto'
import type { Queryable } from './db.js'

/**
 * Tenant dono da chave. `selfService`: conta do produto (login, assinatura) ou empresa de escritório, que passa pelo
 * `emission_block` antes de pôr a nota na fila; `false` só para o tenant de integração antigo, criado à mão.
 * `escritorio`: plano Escritório (a chave emite por qualquer empresa ativa da conta, com `cnpj_prestador`).
 */
export type AuthenticatedTenant = { id: string; active: boolean; selfService?: boolean; escritorio?: boolean }

export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex')
}

export async function findTenantByApiKey(db: Queryable, apiKey: string | null): Promise<AuthenticatedTenant | null> {
  if (!apiKey) return null
  const { rows } = await db.query<{ id: string; active: boolean; self_service: boolean; escritorio: boolean }>(
    `select id, active, (client_id is not null or escritorio_tenant_id is not null) as self_service,
            nofiscal.plano_de_escritorio(plan) as escritorio
       from nofiscal.fiscal_tenants where api_key_hash = $1`,
    [hashApiKey(apiKey)],
  )
  const t = rows[0]
  return t ? { id: t.id, active: t.active, selfService: t.self_service, escritorio: t.escritorio } : null
}

/** Compara `Authorization: Bearer <segredo>` em tempo constante. Sem segredo configurado, nega. */
export function bearerMatches(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header) return false
  const expected = Buffer.from(`Bearer ${secret}`, 'utf8')
  const received = Buffer.from(header, 'utf8')
  return expected.length === received.length && timingSafeEqual(expected, received)
}
