// Entregas do agente por e-mail (critérios 6 e 25). Este módulo decide **quem** recebe;
// o envio e o WhatsApp entram no lote B. No Pro, o tomador e o contador recebem a cópia;
// no Inicial, só o dono. O dono é a conta com `fiscal_accounts.client_id` do tenant.
import type { Queryable } from '../db.js'

export type PapelDoDestinatario = 'dono' | 'tomador' | 'contador'
export type Destinatario = { papel: PapelDoDestinatario; email: string }

export async function destinatariosDoEmail(
  db: Queryable,
  tenantId: string,
  opcoes: { tomadorEmail?: string | null },
): Promise<Destinatario[]> {
  const { rows } = await db.query<{ plan: string; contador_email: string | null; dono_email: string | null }>(
    `select t.plan, t.contador_email, a.email as dono_email
       from nofiscal.fiscal_tenants t
       left join nofiscal.fiscal_accounts a on a.client_id = t.client_id
      where t.id = $1`,
    [tenantId],
  )
  const tenant = rows[0]
  if (!tenant) return []

  const lista: Destinatario[] = []
  const incluir = (papel: PapelDoDestinatario, email: string | null | undefined) => {
    const limpo = email?.trim().toLowerCase()
    if (limpo && !lista.some((d) => d.email === limpo)) lista.push({ papel, email: limpo })
  }
  incluir('dono', tenant.dono_email)
  if (tenant.plan === 'pro') {
    incluir('tomador', opcoes.tomadorEmail)
    incluir('contador', tenant.contador_email)
  }
  return lista
}
