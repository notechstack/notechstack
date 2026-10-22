// Notas vistas pela API. A idempotência por venda (critério 8) mora no banco:
// UNIQUE (tenant_id, external_id) + `on conflict do nothing`. Dois POST simultâneos
// com o mesmo external_id esperam um pelo outro no índice e devolvem a mesma linha.
import type { Queryable } from './db.js'
import type { NewInvoice } from './validation.js'

export type InvoiceStatus =
  | 'queued'
  | 'signing'
  | 'sent'
  | 'issued'
  | 'rejected'
  | 'cancel_requested'
  | 'cancelled'
  | 'skipped'

export type InvoiceView = {
  id: string
  external_id: string
  status: InvoiceStatus
  chave_acesso: string | null
  last_error_code: string | null
}

const VIEW_COLUMNS = 'id, external_id, status, chave_acesso, last_error_code'

export async function createOrGetInvoice(db: Queryable, tenantId: string, invoice: NewInvoice): Promise<InvoiceView> {
  const inserted = await db.query<InvoiceView>(
    `insert into nofiscal.fiscal_invoices (tenant_id, external_id, payload)
     values ($1, $2, $3::jsonb)
     on conflict (tenant_id, external_id) do nothing
     returning ${VIEW_COLUMNS}`,
    [tenantId, invoice.external_id, JSON.stringify(invoice.payload)],
  )
  if (inserted.rows[0]) return inserted.rows[0]
  const existing = await db.query<InvoiceView>(
    `select ${VIEW_COLUMNS} from nofiscal.fiscal_invoices where tenant_id = $1 and external_id = $2`,
    [tenantId, invoice.external_id],
  )
  if (!existing.rows[0]) throw new Error('nota não encontrada depois do conflito de external_id')
  return existing.rows[0]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Nota do tenant; `null` quando não existe ou é de outro tenant (critério 23: 404 nos dois casos). */
export async function findInvoiceForTenant(db: Queryable, tenantId: string, id: string): Promise<InvoiceView | null> {
  if (!UUID.test(id)) return null
  const { rows } = await db.query<InvoiceView>(
    `select ${VIEW_COLUMNS} from nofiscal.fiscal_invoices where id = $1 and tenant_id = $2`,
    [id, tenantId],
  )
  return rows[0] ?? null
}
