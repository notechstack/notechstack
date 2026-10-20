// Chamada interna que roda o motor (Unresolved 26: a API devolve 202 e o trabalho com a
// Sefin roda numa chamada separada, disparada pelo agendador). Autenticação:
// `Authorization: Bearer ${CRON_SECRET}`, o header que o Vercel Cron envia; forma literal
// no Landing do checklist (lote 2a - trabalho assíncrono).
import { entregar, notaDoAgente, tarefasDoAgente, type AgenteDeps } from './agente/tarefas.js'
import { bearerMatches } from './auth.js'
import { sendInvoiceCallback, type FetchLike } from './callback.js'
import { runCancellations } from './cancel.js'
import { findExpiringCertificates } from './cert-expiry.js'
import type { Db } from './db.js'
import { runEmission, type FinalStatus } from './emission.js'
import { errorResponse, json } from './http.js'
import { logEvent } from './log.js'
import type { SefinClient } from './sefin.js'

export type WorkerDeps = {
  db: Db
  sefin: SefinClient | null
  cronSecret: string | undefined
  fetch: FetchLike
  now?: () => Date
  /** Restringe a execução a um tenant (testes). */
  tenantId?: string
  /** Canais do agente fiscal; sem eles, tenant self-service cai no callback HTTP. */
  agente?: AgenteDeps
}

export async function handleWorkerRequest(request: Request, deps: WorkerDeps): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'use GET ou POST')
  if (!bearerMatches(request.headers.get('authorization'), deps.cronSecret)) {
    return errorResponse('UNAUTHORIZED', 'credencial do agendador ausente ou inválida')
  }
  // Sem cliente (só em teste ou configuração quebrada) o worker não toca em nada.
  if (!deps.sefin) return errorResponse('SEFIN_NOT_CONFIGURED', 'cliente da Sefin não configurado')

  const now = deps.now ?? (() => new Date())
  const agente = deps.agente
  try {
    // Tenant self-service: a transição vai ao agente (WhatsApp e e-mail), no mesmo processo;
    // os demais seguem no callback HTTP (Landing de .checks/agente-fiscal-whatsapp.md, lote B).
    const onFinal = async (invoiceId: string, status: FinalStatus) => {
      if (await notaDoAgente(deps.db, invoiceId)) {
        if (agente) return entregar(deps.db, agente, invoiceId, status)
        logEvent('agente.nao_configurado', { invoice_id: invoiceId })
      }
      await sendInvoiceCallback({ db: deps.db, fetch: deps.fetch }, invoiceId)
    }
    const summary = await runEmission({ db: deps.db, sefin: deps.sefin, now, onFinal, tenantId: deps.tenantId })
    // Cancelamentos depois da emissão (Landing, lote 2b - cancelamento).
    const cancellations = await runCancellations({ db: deps.db, sefin: deps.sefin, now, onFinal, tenantId: deps.tenantId })
    const expiring = await findExpiringCertificates(deps.db, now())
    for (const cert of expiring) {
      logEvent('nofiscal.certificate_expiring', {
        tenant_id: cert.tenant_id,
        cnpj: cert.cnpj,
        not_after: cert.not_after.toISOString(),
        expired: cert.expired,
      })
    }
    const tarefas = agente ? await tarefasDoAgente(deps.db, { now, ...agente }, { tenantId: deps.tenantId }) : null
    return json(200, { ...summary, cancellations, certificates_expiring: expiring.length, ...(tarefas ? { agente: tarefas } : {}) })
  } catch (error) {
    logEvent('nofiscal.worker_failed', { error_name: error instanceof Error ? error.name : 'unknown' })
    return errorResponse('INTERNAL', 'erro interno')
  }
}
