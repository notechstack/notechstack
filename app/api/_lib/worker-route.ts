// Chamada interna que roda o motor (Unresolved 26: a API devolve 202 e o trabalho com a
// Sefin roda numa chamada separada, disparada pelo agendador). Autenticação:
// `Authorization: Bearer ${CRON_SECRET}`, o header que o Vercel Cron envia; forma literal
// no Landing do checklist (lote 2a - trabalho assíncrono).
import type { DistribuicaoAdn } from './adn.js'
import { entregar, notaDoAgente, tarefasDoAgente, type AgenteDeps } from './agente/tarefas.js'
import { bearerMatches } from './auth.js'
import { runCancellations } from './cancel.js'
import { findExpiringCertificates } from './cert-expiry.js'
import type { Db } from './db.js'
import { runEmission, type FinalStatus } from './emission.js'
import { errorResponse, json } from './http.js'
import { logEvent } from './log.js'
import { processarNfes, type ResumoNfe } from './nfe/servico.js'
import type { SefazClient } from './nfe/sefaz-client.js'
import type { ResponsavelTecnico } from './nfe/nfe-builder.js'
import { enfileirarNfe, enfileirarNfse, entregarWebhooks, type FetchLike, type ResumoWebhooks } from './parceiro/webhook.js'
import { conferirPendentes, type ResumoConferencias } from './procuracao.js'
import type { SefinClient } from './sefin.js'

export type WorkerDeps = {
  db: Db
  sefin: SefinClient | null
  cronSecret: string | undefined
  fetch: FetchLike
  now?: () => Date
  /** Restringe a execução a um tenant (testes). */
  tenantId?: string
  /** Canais do agente fiscal (WhatsApp e e-mail das contas self-service). O webhook do parceiro sai sempre. */
  agente?: AgenteDeps
  /** ADN para conferir as procurações (migração 20261111180000); sem ele, a conferência não roda. */
  adn?: DistribuicaoAdn
  /** Sefaz da NF-e (migração 20261117090000); sem ela, a fila da NF-e não roda. */
  nfe?: { sefaz: SefazClient; responsavelTecnico: ResponsavelTecnico | null }
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
    // Toda transição final vira evento do webhook da conta-mãe (se ela tiver URL), gravado na fila antes de qualquer
    // envio; a entrega sai no fim desta rodada e, se falhar, nas próximas (parceiro/webhook.ts). Tenant self-service:
    // a transição também vai ao agente (WhatsApp e e-mail), no mesmo processo.
    const onFinal = async (invoiceId: string, status: FinalStatus) => {
      try {
        await enfileirarNfse(deps.db, invoiceId, status)
      } catch (error) {
        logEvent('nofiscal.webhook_nao_gravado', { invoice_id: invoiceId, error_name: error instanceof Error ? error.name : 'unknown' })
      }
      if (await notaDoAgente(deps.db, invoiceId)) {
        if (agente) return entregar(deps.db, agente, invoiceId, status)
        logEvent('agente.nao_configurado', { invoice_id: invoiceId })
      }
    }
    // Procurações antes da emissão: a confirmada no ADN já libera a nota desta rodada. Falha aqui não para o motor.
    let procuracoes: ResumoConferencias | null = null
    if (deps.adn) {
      try {
        procuracoes = await conferirPendentes({ db: deps.db, adn: deps.adn, now }, { tenantId: deps.tenantId })
      } catch (error) {
        logEvent('nofiscal.procuracao_rodada_falhou', { error_name: error instanceof Error ? error.name : 'unknown' })
      }
    }
    const summary = await runEmission({ db: deps.db, sefin: deps.sefin, now, onFinal, tenantId: deps.tenantId })
    // Cancelamentos depois da emissão (Landing, lote 2b - cancelamento).
    const cancellations = await runCancellations({ db: deps.db, sefin: deps.sefin, now, onFinal, tenantId: deps.tenantId })
    // NF-e (nota de produto) depois da NFS-e. Falha aqui não para o resto do worker.
    let nfe: ResumoNfe | null = null
    if (deps.nfe) {
      try {
        nfe = await processarNfes({
          db: deps.db,
          sefaz: deps.nfe.sefaz,
          now,
          responsavelTecnico: deps.nfe.responsavelTecnico,
          tenantId: deps.tenantId,
          onFinal: async (nfeId, status) => {
            await enfileirarNfe(deps.db, nfeId, status).catch((error) =>
              logEvent('nofiscal.webhook_nao_gravado', { nfe_id: nfeId, error_name: error instanceof Error ? error.name : 'unknown' }),
            )
          },
        })
      } catch (error) {
        logEvent('nofiscal.nfe_rodada_falhou', { error_name: error instanceof Error ? error.name : 'unknown' })
      }
    }
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
    // Webhook do parceiro por último: entrega os eventos desta rodada e os reenvios cuja hora chegou.
    let webhooks: ResumoWebhooks | null = null
    try {
      webhooks = await entregarWebhooks({ db: deps.db, fetch: deps.fetch, now, donoId: deps.tenantId ? await donoDe(deps.db, deps.tenantId) : undefined })
    } catch (error) {
      logEvent('nofiscal.webhook_rodada_falhou', { error_name: error instanceof Error ? error.name : 'unknown' })
    }
    return json(200, {
      ...summary,
      cancellations,
      certificates_expiring: expiring.length,
      ...(procuracoes ? { procuracoes } : {}),
      ...(nfe ? { nfe } : {}),
      ...(tarefas ? { agente: tarefas } : {}),
      ...(webhooks ? { webhooks } : {}),
    })
  } catch (error) {
    logEvent('nofiscal.worker_failed', { error_name: error instanceof Error ? error.name : 'unknown' })
    return errorResponse('INTERNAL', 'erro interno')
  }
}

/** Conta-mãe do tenant (teste com `tenantId`: só os webhooks daquela conta). */
async function donoDe(db: Db, tenantId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>('select nofiscal.dono_do_tenant($1) as id', [tenantId])
  return rows[0]?.id ?? tenantId
}
