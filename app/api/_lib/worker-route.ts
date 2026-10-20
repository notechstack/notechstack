// Chamada interna que roda o motor (Unresolved 26: a API devolve 202 e o trabalho com a
// Sefin roda numa chamada separada, disparada pelo agendador). Autenticação:
// `Authorization: Bearer ${CRON_SECRET}`, o header que o Vercel Cron envia; forma literal
// no Landing do checklist (lote 2a - trabalho assíncrono).
import { bearerMatches } from './auth.js'
import { sendInvoiceCallback, type FetchLike } from './callback.js'
import { findExpiringCertificates } from './cert-expiry.js'
import type { Db } from './db.js'
import { runEmission } from './emission.js'
import { errorResponse, json } from './http.js'
import { logEvent } from './log.js'
import type { SefinClient } from './sefin.js'

export type WorkerDeps = {
  db: Db
  sefin: SefinClient | null
  cronSecret: string | undefined
  fetch: FetchLike
  now?: () => Date
}

export async function handleWorkerRequest(request: Request, deps: WorkerDeps): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'use GET ou POST')
  if (!bearerMatches(request.headers.get('authorization'), deps.cronSecret)) {
    return errorResponse('UNAUTHORIZED', 'credencial do agendador ausente ou inválida')
  }
  if (!deps.sefin) return errorResponse('SEFIN_NOT_CONFIGURED', 'cliente da Sefin ainda não configurado')

  const now = deps.now ?? (() => new Date())
  try {
    const summary = await runEmission({
      db: deps.db,
      sefin: deps.sefin,
      now,
      onFinal: async (invoiceId) => {
        await sendInvoiceCallback({ db: deps.db, fetch: deps.fetch }, invoiceId)
      },
    })
    const expiring = await findExpiringCertificates(deps.db, now())
    for (const cert of expiring) {
      logEvent('nofiscal.certificate_expiring', {
        tenant_id: cert.tenant_id,
        cnpj: cert.cnpj,
        not_after: cert.not_after.toISOString(),
        expired: cert.expired,
      })
    }
    return json(200, { ...summary, certificates_expiring: expiring.length })
  } catch (error) {
    logEvent('nofiscal.worker_failed', { error_name: error instanceof Error ? error.name : 'unknown' })
    return errorResponse('INTERNAL', 'erro interno')
  }
}
