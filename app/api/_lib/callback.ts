// Callback ao cliente (critério 3). Corpo, header e reenvio: Unresolved 13 da tarefa, valor
// de "Until answered"; forma literal no Landing do checklist (lote 2a - callback).
// A assinatura é o HMAC-SHA256 dos bytes exatos enviados, com o segredo do tenant lido do
// Supabase Vault por `nofiscal.read_webhook_secret`.
import { createHmac } from 'node:crypto'
import type { Queryable } from './db.js'
import { logEvent } from './log.js'

export const SIGNATURE_HEADER = 'x-nofiscal-signature'
export const RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000] as const
const REQUEST_TIMEOUT_MS = 10_000

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>

export type CallbackDeps = {
  db: Queryable
  fetch: FetchLike
  sleep?: (ms: number) => Promise<void>
}

export type CallbackResult =
  | { delivered: true; attempts: number }
  | { delivered: false; reason: 'NO_WEBHOOK_URL' | 'NO_WEBHOOK_SECRET' | 'NOT_FOUND' | 'GAVE_UP'; attempts: number }

export function signBody(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function sendInvoiceCallback(deps: CallbackDeps, invoiceId: string): Promise<CallbackResult> {
  const { rows } = await deps.db.query<{
    id: string
    external_id: string
    status: string
    chave_acesso: string | null
    last_error_code: string | null
    tenant_id: string
    webhook_url: string | null
  }>(
    `select i.id, i.external_id, i.status, i.chave_acesso, i.last_error_code, i.tenant_id, t.webhook_url
       from nofiscal.fiscal_invoices i
       join nofiscal.fiscal_tenants t on t.id = i.tenant_id
      where i.id = $1`,
    [invoiceId],
  )
  const row = rows[0]
  if (!row) return { delivered: false, reason: 'NOT_FOUND', attempts: 0 }
  if (!row.webhook_url) return { delivered: false, reason: 'NO_WEBHOOK_URL', attempts: 0 }

  const secretRow = await deps.db.query<{ secret: string | null }>('select nofiscal.read_webhook_secret($1) as secret', [
    row.tenant_id,
  ])
  const secret = secretRow.rows[0]?.secret
  if (!secret) return { delivered: false, reason: 'NO_WEBHOOK_SECRET', attempts: 0 }

  const body = JSON.stringify({
    id: row.id,
    external_id: row.external_id,
    status: row.status,
    chave_acesso: row.chave_acesso,
    last_error_code: row.last_error_code,
  })
  const headers = { 'content-type': 'application/json', [SIGNATURE_HEADER]: signBody(body, secret) }
  const sleep = deps.sleep ?? defaultSleep

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1])
    let status: number
    try {
      const response = await deps.fetch(row.webhook_url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (response.ok) {
        logEvent('nofiscal.callback_delivered', { invoice_id: row.id, attempts: attempt + 1 })
        return { delivered: true, attempts: attempt + 1 }
      }
      status = response.status
    } catch {
      status = 0
    }
    logEvent('nofiscal.callback_attempt_failed', { invoice_id: row.id, attempt: attempt + 1, http_status: status })
  }
  return { delivered: false, reason: 'GAVE_UP', attempts: RETRY_DELAYS_MS.length + 1 }
}
