// Autenticação da API por `x-api-key` (critério 23). O Nó guarda só o sha256 hex da chave
// (`fiscal_tenants.api_key_hash`, critério 28); a busca é pelo hash, nunca pela chave.
// Sandbox (19/11/2026): chave `nfk_test_…`, procurada só em `fiscal_sandbox_contas.api_key_hash`; a de produção, só
// em `fiscal_tenants.api_key_hash`. Uma nunca é achada na tabela da outra.
import { createHash, timingSafeEqual } from 'node:crypto'
import type { Queryable } from './db.js'

/**
 * Tenant dono da chave. `selfService`: conta do produto (login, assinatura) ou empresa de escritório, que passa pelo
 * `emission_block` antes de pôr a nota na fila; `false` só para o tenant de integração antigo, criado à mão.
 * `escritorio`: plano Escritório (a chave emite por qualquer empresa ativa da conta, com `cnpj_prestador`).
 */
export type AuthenticatedTenant = {
  id: string
  active: boolean
  selfService?: boolean
  escritorio?: boolean
  /** Chave `nfk_test_…`: tudo vai para as tabelas do sandbox (sandbox/notas.ts), nada para o motor. */
  sandbox?: boolean
}

export const PREFIXO_SANDBOX = 'nfk_test_'

export const ehChaveSandbox = (chave: string) => chave.startsWith(PREFIXO_SANDBOX)

export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex')
}

export async function findTenantByApiKey(db: Queryable, apiKey: string | null): Promise<AuthenticatedTenant | null> {
  if (!apiKey) return null
  if (ehChaveSandbox(apiKey)) {
    const { rows } = await db.query<{ id: string; active: boolean; self_service: boolean; escritorio: boolean }>(
      `select t.id, t.active, (t.client_id is not null or t.escritorio_tenant_id is not null) as self_service,
              nofiscal.plano_de_escritorio(t.plan) as escritorio
         from nofiscal.fiscal_sandbox_contas c
         join nofiscal.fiscal_tenants t on t.id = c.dono_tenant_id
        where c.api_key_hash = $1`,
      [hashApiKey(apiKey)],
    )
    const t = rows[0]
    return t ? { id: t.id, active: t.active, selfService: t.self_service, escritorio: t.escritorio, sandbox: true } : null
  }
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
