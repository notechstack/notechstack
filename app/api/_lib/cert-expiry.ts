// Alerta de vencimento do A1 (critério 16): entra no alerta o certificado com `not_after`
// a 30 dias ou menos, inclusive o já vencido. O canal do alerta segue em aberto
// (Unresolved 21 da tarefa: e-mail diário para Lucca); este módulo só decide quem entra.
import type { Queryable } from './db.js'

export const ALERT_WINDOW_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

export type ExpiringCertificate = {
  tenant_id: string
  cnpj: string
  razao_social: string
  not_after: Date
  expired: boolean
}

export function isInAlertWindow(notAfter: Date, now: Date, days = ALERT_WINDOW_DAYS): boolean {
  return notAfter.getTime() - now.getTime() <= days * DAY_MS
}

export async function findExpiringCertificates(
  db: Queryable,
  now: Date,
  options: { days?: number; tenantId?: string } = {},
): Promise<ExpiringCertificate[]> {
  const days = options.days ?? ALERT_WINDOW_DAYS
  const limit = new Date(now.getTime() + days * DAY_MS)
  const { rows } = await db.query<{ tenant_id: string; cnpj: string; razao_social: string; not_after: Date }>(
    `select t.id as tenant_id, t.cnpj, t.razao_social, c.not_after
       from nofiscal.fiscal_certificates c
       join nofiscal.fiscal_tenants t on t.id = c.tenant_id
      where t.active
        and c.not_after <= $1
        and ($2::uuid is null or t.id = $2)
      order by c.not_after`,
    [limit, options.tenantId ?? null],
  )
  return rows
    .filter((row) => isInAlertWindow(row.not_after, now, days))
    .map((row) => ({ ...row, expired: row.not_after.getTime() <= now.getTime() }))
}
