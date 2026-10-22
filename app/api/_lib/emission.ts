// Motor de emissão: leva as notas de `queued` a `issued` ou `rejected`, chamado pelo worker
// (`api/internal/nfse-worker.ts`), nunca pela requisição da Prontia (Unresolved 26).
//
// Estados (seção States da tarefa): queued → signing → sent → issued | rejected.
// Retentativa (critério 10 e Unresolved 13, forma literal no Landing do checklist):
// - `attempts` conta rodadas que tocam a Sefin; nunca passa de 5 (CHECK no banco e aqui);
// - antes de transmitir, a nota vai a `sent` com `next_attempt_at` = agora + espera, que é
//   também a trava contra outro worker; esperas de 1, 5, 15, 60 e 240 min;
// - da 2ª rodada em diante, consulta pela DPS (`id_dps`) antes de reenviar;
// - depois da 5ª falha, a rodada seguinte só consulta: achou → issued; senão → rejected
//   com `last_error_code = 'SEFIN_UNAVAILABLE'`.
// Pausas: tenant inativo (critério 27) e certificado vencido (critério 17) não são
// selecionados; a nota fica `queued` e sai sozinha quando o tenant volta ou o A1 é trocado.
// Configuração incompleta (série única, `p_tot_trib_sn` fora do MEI) deixa a nota `queued` com o código
// `SERIE_NOT_CONFIGURED` ou `TRIBUTOS_NOT_CONFIGURED` e a revê em 5 min.
// O limite do plano não entra na seleção (critério 29).
import type { Db, Queryable } from './db.js'
import { allocateDpsNumber } from './dps-number.js'
import { logEvent } from './log.js'
import { errorText, MAX_ERROR_LENGTH, redactCertificate } from './redact.js'
import type {
  Ambiente,
  Certificado,
  ConsultaResultado,
  EmitirResultado,
  SefinClient,
  SefinInvoice,
  SefinTenant,
} from './sefin.js'

export const MAX_ATTEMPTS = 5
export const BACKOFF_MINUTES = [1, 5, 15, 60, 240] as const
export const CLAIM_LEASE_MINUTES = 5
export const DEFAULT_BATCH = 25

/** Estados que disparam o callback ao cliente (Landing, lotes 2a e 2b). */
export type FinalStatus = 'issued' | 'rejected' | 'cancelled' | 'cancel_refused'

export type EmissionDeps = {
  db: Db
  sefin: SefinClient
  now: () => Date
  /** Chamado quando a nota chega a `issued` ou `rejected` (callback ao cliente, critério 3). */
  onFinal?: (invoiceId: string, status: FinalStatus) => Promise<void>
  limit?: number
  /** Restringe a execução a um tenant (testes e reprocessamento manual). */
  tenantId?: string
}

export type EmissionSummary = {
  claimed: number
  issued: number
  rejected: number
  retrying: number
  skipped_serie: number
  skipped_tributos: number
  failed: number
  paused_cert_expired: number
}

type Plan = 'transmit' | 'retry' | 'final_consult' | 'skip' | 'skip_tributos'

type ClaimedRow = {
  id: string
  tenant_id: string
  external_id: string
  status: 'queued' | 'signing' | 'sent'
  payload: unknown
  dps_serie: string | null
  dps_numero: string | null
  id_dps: string | null
  attempts: number
  cnpj: string
  razao_social: string
  inscricao_municipal: string | null
  codigo_municipio_ibge: string
  regime: string
  ambiente: Ambiente
  p_tot_trib_sn: string | null
}

type Claimed = { plan: Plan; tenant: SefinTenant; invoice: SefinInvoice | null; attempts: number }

const minutesFrom = (now: Date, minutes: number) => new Date(now.getTime() + minutes * 60_000)

export async function runEmission(deps: EmissionDeps): Promise<EmissionSummary> {
  const now = deps.now()
  const summary: EmissionSummary = {
    claimed: 0,
    issued: 0,
    rejected: 0,
    retrying: 0,
    skipped_serie: 0,
    skipped_tributos: 0,
    failed: 0,
    paused_cert_expired: await markCertExpired(deps.db, now, deps.tenantId ?? null),
  }
  const tried: string[] = []
  const limit = deps.limit ?? DEFAULT_BATCH

  for (let i = 0; i < limit; i++) {
    let claimed: (Claimed & { id: string }) | null
    try {
      claimed = await deps.db.transaction((tx) => claimNext(tx, deps.sefin, now, deps.tenantId ?? null, tried))
    } catch (error) {
      summary.failed++
      logEvent('nofiscal.claim_failed', { error_name: error instanceof Error ? error.name : 'unknown' })
      const stuck = (error as { invoiceId?: string }).invoiceId
      if (!stuck) break
      tried.push(stuck)
      continue
    }
    if (!claimed) break
    tried.push(claimed.id)
    summary.claimed++
    if (claimed.plan === 'skip') {
      summary.skipped_serie++
      continue
    }
    if (claimed.plan === 'skip_tributos') {
      summary.skipped_tributos++
      continue
    }
    const outcome = await processClaimed(deps, now, claimed)
    summary[outcome]++
    if (outcome === 'issued' || outcome === 'rejected') await notifyFinal(deps, claimed.id, outcome)
  }

  logEvent('nofiscal.emission_run', summary)
  return summary
}

/** Contrato com a Prontia (Landing, lote 3): nota pausada pelo critério 17 expõe `CERT_EXPIRED`. */
async function markCertExpired(db: Queryable, now: Date, tenantId: string | null): Promise<number> {
  const { rowCount } = await db.query(
    `update nofiscal.fiscal_invoices i
        set last_error_code = 'CERT_EXPIRED', updated_at = $1
       from nofiscal.fiscal_certificates c
      where c.tenant_id = i.tenant_id
        and c.not_after <= $1
        and i.status = 'queued'
        and i.last_error_code is distinct from 'CERT_EXPIRED'
        and ($2::uuid is null or i.tenant_id = $2)`,
    [now, tenantId],
  )
  return rowCount
}

async function claimNext(
  tx: Queryable,
  sefin: SefinClient,
  now: Date,
  tenantId: string | null,
  tried: string[],
): Promise<(Claimed & { id: string }) | null> {
  const { rows } = await tx.query<ClaimedRow>(
    `select i.id, i.tenant_id, i.external_id, i.status, i.payload, i.dps_serie, i.dps_numero, i.id_dps, i.attempts,
            t.cnpj, t.razao_social, t.inscricao_municipal, t.codigo_municipio_ibge, t.regime, t.ambiente, t.p_tot_trib_sn
       from nofiscal.fiscal_invoices i
       join nofiscal.fiscal_tenants t on t.id = i.tenant_id
       join nofiscal.fiscal_certificates c on c.tenant_id = t.id
      where t.active
        and c.not_after > $1
        and i.status in ('queued', 'signing', 'sent')
        and (i.next_attempt_at is null or i.next_attempt_at <= $1)
        and ($2::uuid is null or i.tenant_id = $2)
        and not (i.id = any($3::uuid[]))
      order by i.created_at
      limit 1
      for update of i skip locked`,
    [now, tenantId, tried],
  )
  const row = rows[0]
  if (!row) return null

  const tenant: SefinTenant = {
    id: row.tenant_id,
    cnpj: row.cnpj,
    razao_social: row.razao_social,
    inscricao_municipal: row.inscricao_municipal,
    codigo_municipio_ibge: row.codigo_municipio_ibge,
    regime: row.regime,
    ambiente: row.ambiente,
    p_tot_trib_sn: row.p_tot_trib_sn,
  }
  const lease = minutesFrom(now, CLAIM_LEASE_MINUTES)

  try {
    if (row.status === 'queued') {
      const series = await tx.query<{ serie: string }>(
        'select serie from nofiscal.fiscal_dps_series where tenant_id = $1 order by serie limit 2',
        [row.tenant_id],
      )
      if (series.rows.length !== 1) {
        await tx.query(
          `update nofiscal.fiscal_invoices
              set last_error_code = 'SERIE_NOT_CONFIGURED', next_attempt_at = $2, updated_at = $3
            where id = $1`,
          [row.id, lease, now],
        )
        return { id: row.id, plan: 'skip', tenant, invoice: null, attempts: row.attempts }
      }
      if (row.p_tot_trib_sn === null && row.regime !== 'mei') {
        await tx.query(
          `update nofiscal.fiscal_invoices
              set last_error_code = 'TRIBUTOS_NOT_CONFIGURED', next_attempt_at = $2, updated_at = $3
            where id = $1`,
          [row.id, lease, now],
        )
        return { id: row.id, plan: 'skip_tributos', tenant, invoice: null, attempts: row.attempts }
      }
      const serie = series.rows[0].serie
      const numero = await allocateDpsNumber(tx, row.tenant_id, serie)
      const idDps = sefin.idDps({ tenant, serie, numero })
      await tx.query(
        `update nofiscal.fiscal_invoices
            set status = 'signing', dps_serie = $2, dps_numero = $3, id_dps = $4,
                last_error_code = null, last_error = null, next_attempt_at = $5, updated_at = $6
          where id = $1`,
        [row.id, serie, numero, idDps, lease, now],
      )
      return {
        id: row.id,
        plan: 'transmit',
        tenant,
        attempts: row.attempts,
        invoice: { id: row.id, external_id: row.external_id, payload: row.payload, dps_serie: serie, dps_numero: numero, id_dps: idDps },
      }
    }

    const invoice: SefinInvoice = {
      id: row.id,
      external_id: row.external_id,
      payload: row.payload,
      dps_serie: row.dps_serie as string,
      dps_numero: Number(row.dps_numero),
      id_dps: row.id_dps as string,
    }

    if (row.status === 'signing') {
      // Lease vencido em `signing`: nada foi transmitido ainda (a nota vai a `sent` antes).
      await tx.query('update nofiscal.fiscal_invoices set next_attempt_at = $2, updated_at = $3 where id = $1', [
        row.id,
        lease,
        now,
      ])
      return { id: row.id, plan: 'transmit', tenant, invoice, attempts: row.attempts }
    }

    if (row.attempts >= MAX_ATTEMPTS) {
      await tx.query('update nofiscal.fiscal_invoices set next_attempt_at = $2, updated_at = $3 where id = $1', [
        row.id,
        lease,
        now,
      ])
      return { id: row.id, plan: 'final_consult', tenant, invoice, attempts: row.attempts }
    }

    const attempts = row.attempts + 1
    await tx.query(
      'update nofiscal.fiscal_invoices set attempts = $2, next_attempt_at = $3, updated_at = $4 where id = $1',
      [row.id, attempts, minutesFrom(now, BACKOFF_MINUTES[attempts - 1]), now],
    )
    return { id: row.id, plan: 'retry', tenant, invoice, attempts }
  } catch (error) {
    // A transação volta inteira (o número alocado também); a nota não é tentada de novo nesta execução.
    Object.assign(error as object, { invoiceId: row.id })
    throw error
  }
}

type Outcome = 'issued' | 'rejected' | 'retrying' | 'failed'

async function processClaimed(deps: EmissionDeps, now: Date, claimed: Claimed & { id: string }): Promise<Outcome> {
  const { db, sefin } = deps
  const invoice = claimed.invoice as SefinInvoice
  try {
    const certificado = await readCertificate(db, claimed.tenant.id)
    if (!certificado) {
      logEvent('nofiscal.certificate_missing', { invoice_id: claimed.id })
      return 'failed'
    }
    const cert = certificado

    const consultar = async (): Promise<ConsultaResultado> => {
      try {
        return await sefin.consultarPorIdDps({ tenant: claimed.tenant, idDps: invoice.id_dps, certificado: cert })
      } catch (error) {
        return { kind: 'unavailable', reason: errorText(error) }
      }
    }
    const emitir = async (): Promise<EmitirResultado> => {
      try {
        return await sefin.emitir({ tenant: claimed.tenant, invoice, certificado: cert })
      } catch (error) {
        return { kind: 'unavailable', reason: errorText(error) }
      }
    }

    if (claimed.plan === 'transmit') {
      const attempts = claimed.attempts + 1
      await db.query(
        `update nofiscal.fiscal_invoices
            set status = 'sent', attempts = $2, next_attempt_at = $3, updated_at = $4
          where id = $1 and status = 'signing'`,
        [claimed.id, attempts, minutesFrom(now, BACKOFF_MINUTES[attempts - 1]), now],
      )
      return await applyEmitir(db, now, claimed.id, await emitir(), cert)
    }

    const consulta = await consultar()
    if (consulta.kind === 'found') return await markIssued(db, now, claimed.id, consulta.chaveAcesso, null, consulta.xmlNfse, cert)

    if (claimed.plan === 'final_consult') {
      const reason = consulta.kind === 'unavailable' ? consulta.reason : 'DPS não encontrada após 5 tentativas'
      return await markRejected(db, now, claimed.id, 'SEFIN_UNAVAILABLE', reason, cert)
    }
    if (consulta.kind === 'unavailable') return await markRetrying(db, now, claimed.id, consulta.reason, cert)
    return await applyEmitir(db, now, claimed.id, await emitir(), cert)
  } catch (error) {
    logEvent('nofiscal.process_failed', {
      invoice_id: claimed.id,
      error_name: error instanceof Error ? error.name : 'unknown',
    })
    return 'failed'
  }
}

async function readCertificate(db: Queryable, tenantId: string): Promise<Certificado | null> {
  const { rows } = await db.query<{ pfx_base64: string; password: string }>(
    'select pfx_base64, password from nofiscal.read_certificate($1)',
    [tenantId],
  )
  const row = rows[0]
  return row ? { pfxBase64: row.pfx_base64, password: row.password } : null
}

function applyEmitir(db: Queryable, now: Date, id: string, result: EmitirResultado, cert: Certificado): Promise<Outcome> {
  if (result.kind === 'authorized') return markIssued(db, now, id, result.chaveAcesso, result.xmlDps, result.xmlNfse, cert)
  // Rejeição de dado: sem nova tentativa (critério 14). O destino do número segue em Unresolved 1.
  if (result.kind === 'rejected') return markRejected(db, now, id, result.code, result.message, cert)
  return markRetrying(db, now, id, result.reason, cert)
}

async function markIssued(
  db: Queryable,
  now: Date,
  id: string,
  chaveAcesso: string,
  xmlDps: string | null,
  xmlNfse: string,
  cert: Certificado,
): Promise<Outcome> {
  await db.query(
    `update nofiscal.fiscal_invoices
        set status = 'issued', chave_acesso = $2, xml_dps = coalesce($3, xml_dps), xml_nfse = $4,
            issued_at = $5, last_error_code = null, last_error = null, next_attempt_at = null, updated_at = $5
      where id = $1 and status = 'sent'`,
    [
      id,
      redactCertificate(chaveAcesso, cert),
      xmlDps === null ? null : redactCertificate(xmlDps, cert),
      redactCertificate(xmlNfse, cert),
      now,
    ],
  )
  logEvent('nofiscal.invoice_issued', { invoice_id: id })
  return 'issued'
}

async function markRejected(
  db: Queryable,
  now: Date,
  id: string,
  code: string,
  message: string,
  cert: Certificado,
): Promise<Outcome> {
  await db.query(
    `update nofiscal.fiscal_invoices
        set status = 'rejected', last_error_code = $2, last_error = $3, next_attempt_at = null, updated_at = $4
      where id = $1 and status = 'sent'`,
    [id, redactCertificate(code, cert, 100), redactCertificate(message, cert, MAX_ERROR_LENGTH), now],
  )
  logEvent('nofiscal.invoice_rejected', { invoice_id: id })
  return 'rejected'
}

async function markRetrying(db: Queryable, now: Date, id: string, reason: string, cert: Certificado): Promise<Outcome> {
  await db.query(
    `update nofiscal.fiscal_invoices
        set last_error_code = 'SEFIN_UNAVAILABLE', last_error = $2, updated_at = $3
      where id = $1 and status = 'sent'`,
    [id, redactCertificate(reason, cert, MAX_ERROR_LENGTH), now],
  )
  logEvent('nofiscal.invoice_retrying', { invoice_id: id })
  return 'retrying'
}

async function notifyFinal(deps: EmissionDeps, id: string, status: FinalStatus): Promise<void> {
  if (!deps.onFinal) return
  try {
    await deps.onFinal(id, status)
  } catch (error) {
    logEvent('nofiscal.callback_failed', { invoice_id: id, error_name: error instanceof Error ? error.name : 'unknown' })
  }
}
