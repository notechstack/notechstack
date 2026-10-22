// Cancelamento (critérios 19, 20 e 21; forma literal no Landing do checklist, lote 2b -
// cancelamento). A rota só registra o pedido; o evento e101101 sai pelo worker, numa chamada
// separada (Unresolved 26):
// - `queued` → `skipped`, sem transmitir (critério 20);
// - `issued` → `cancel_requested`; o worker transmite e101101 e grava cada envio em
//   `fiscal_invoice_events`; aceito → `cancelled` com `cancelled_at` (critério 19);
//   recusado → continua `cancel_requested` com o código da Sefin e não é retransmitido
//   (critério 21); indisponível → `SEFIN_UNAVAILABLE` e nova rodada com espera;
// - qualquer outro status volta como está (`signing`/`sent`: Unresolved 14).
import type { Db, Queryable } from './db.js'
import { BACKOFF_MINUTES, DEFAULT_BATCH, type FinalStatus } from './emission.js'
import type { InvoiceView } from './invoices.js'
import { logEvent } from './log.js'
import { errorText, MAX_ERROR_LENGTH, redactCertificate } from './redact.js'
import type { Ambiente, CancelarResultado, Certificado, ConsultaCancelamentoResultado, SefinClient, SefinTenant } from './sefin.js'

const VIEW_COLUMNS = 'id, external_id, status, chave_acesso, last_error_code'

/** Pedido de cancelamento vindo da API. `null` quando a nota não é do tenant (404). */
export async function requestCancel(db: Queryable, tenantId: string, invoiceId: string, now: Date): Promise<InvoiceView | null> {
  const updated = await db.query<InvoiceView>(
    `update nofiscal.fiscal_invoices
        set status = case status when 'queued' then 'skipped' else 'cancel_requested' end,
            last_error_code = null,
            last_error = case status when 'queued' then 'Cancelada antes da transmissão' else null end,
            next_attempt_at = null,
            updated_at = $3
      where id = $1 and tenant_id = $2 and status in ('queued', 'issued')
      returning ${VIEW_COLUMNS}`,
    [invoiceId, tenantId, now],
  )
  if (updated.rows[0]) {
    logEvent('nofiscal.cancel_requested', { invoice_id: invoiceId, status: updated.rows[0].status })
    return updated.rows[0]
  }
  // Outro status (ou o worker pegou a nota antes): devolve o estado atual, sem efeito.
  const current = await db.query<InvoiceView>(
    `select ${VIEW_COLUMNS} from nofiscal.fiscal_invoices where id = $1 and tenant_id = $2`,
    [invoiceId, tenantId],
  )
  return current.rows[0] ?? null
}

export type CancellationDeps = {
  db: Db
  sefin: SefinClient
  now: () => Date
  onFinal?: (invoiceId: string, status: FinalStatus) => Promise<void>
  limit?: number
  tenantId?: string
}

export type CancellationSummary = {
  claimed: number
  cancelled: number
  refused: number
  retrying: number
  failed: number
}

type ClaimRow = {
  id: string
  tenant_id: string
  chave_acesso: string | null
  tries: string
  cnpj: string
  razao_social: string
  inscricao_municipal: string | null
  codigo_municipio_ibge: string
  regime: string
  ambiente: Ambiente
  p_tot_trib_sn: string | null
}

type Claimed = { id: string; tenant: SefinTenant; chaveAcesso: string; tries: number }

const minutesFrom = (now: Date, minutes: number) => new Date(now.getTime() + minutes * 60_000)
const backoffFor = (transmission: number) => BACKOFF_MINUTES[Math.min(transmission, BACKOFF_MINUTES.length) - 1]

export async function runCancellations(deps: CancellationDeps): Promise<CancellationSummary> {
  const now = deps.now()
  const summary: CancellationSummary = { claimed: 0, cancelled: 0, refused: 0, retrying: 0, failed: 0 }
  const tried: string[] = []
  const limit = deps.limit ?? DEFAULT_BATCH

  for (let i = 0; i < limit; i++) {
    let claimed: Claimed | null
    try {
      claimed = await deps.db.transaction((tx) => claimNext(tx, now, deps.tenantId ?? null, tried))
    } catch (error) {
      summary.failed++
      logEvent('nofiscal.cancel_claim_failed', { error_name: error instanceof Error ? error.name : 'unknown' })
      break
    }
    if (!claimed) break
    tried.push(claimed.id)
    summary.claimed++
    const outcome = await processClaimed(deps, now, claimed)
    summary[outcome]++
    if (outcome === 'cancelled' || outcome === 'refused') {
      try {
        await deps.onFinal?.(claimed.id, outcome === 'cancelled' ? 'cancelled' : 'cancel_refused')
      } catch (error) {
        logEvent('nofiscal.callback_failed', { invoice_id: claimed.id, error_name: error instanceof Error ? error.name : 'unknown' })
      }
    }
  }
  logEvent('nofiscal.cancellation_run', summary)
  return summary
}

async function claimNext(tx: Queryable, now: Date, tenantId: string | null, tried: string[]): Promise<Claimed | null> {
  // Mesmas pausas da emissão: tenant inativo e certificado vencido não transmitem.
  const { rows } = await tx.query<ClaimRow>(
    `select i.id, i.tenant_id, i.chave_acesso,
            (select count(*) from nofiscal.fiscal_invoice_events e where e.invoice_id = i.id and e.tipo = 'e101101') as tries,
            t.cnpj, t.razao_social, t.inscricao_municipal, t.codigo_municipio_ibge, t.regime, t.ambiente, t.p_tot_trib_sn
       from nofiscal.fiscal_invoices i
       join nofiscal.fiscal_tenants t on t.id = i.tenant_id
       join nofiscal.fiscal_certificates c on c.tenant_id = t.id
      where t.active
        and c.not_after > $1
        and i.status = 'cancel_requested'
        and (i.last_error_code is null or i.last_error_code = 'SEFIN_UNAVAILABLE')
        and (i.next_attempt_at is null or i.next_attempt_at <= $1)
        and ($2::uuid is null or i.tenant_id = $2)
        and not (i.id = any($3::uuid[]))
      order by i.updated_at
      limit 1
      for update of i skip locked`,
    [now, tenantId, tried],
  )
  const row = rows[0]
  if (!row) return null
  const tries = Number(row.tries)
  // A espera da próxima rodada é também a trava contra outro worker.
  await tx.query('update nofiscal.fiscal_invoices set next_attempt_at = $2, updated_at = $3 where id = $1', [
    row.id,
    minutesFrom(now, backoffFor(tries + 1)),
    now,
  ])
  return {
    id: row.id,
    chaveAcesso: row.chave_acesso ?? '',
    tries,
    tenant: {
      id: row.tenant_id,
      cnpj: row.cnpj,
      razao_social: row.razao_social,
      inscricao_municipal: row.inscricao_municipal,
      codigo_municipio_ibge: row.codigo_municipio_ibge,
      regime: row.regime,
      ambiente: row.ambiente,
      p_tot_trib_sn: row.p_tot_trib_sn,
    },
  }
}

type Outcome = 'cancelled' | 'refused' | 'retrying' | 'failed'

async function processClaimed(deps: CancellationDeps, now: Date, claimed: Claimed): Promise<Outcome> {
  const { db, sefin } = deps
  try {
    const { rows } = await db.query<{ pfx_base64: string; password: string }>(
      'select pfx_base64, password from nofiscal.read_certificate($1)',
      [claimed.tenant.id],
    )
    if (!rows[0]) {
      logEvent('nofiscal.certificate_missing', { invoice_id: claimed.id })
      return 'failed'
    }
    const cert: Certificado = { pfxBase64: rows[0].pfx_base64, password: rows[0].password }
    if (!claimed.chaveAcesso) {
      return await markRefused(db, now, claimed.id, null, 'NO_CHAVE_ACESSO', 'nota sem chave de acesso', cert)
    }

    // Da 2ª rodada em diante, o 1º envio pode ter chegado e a resposta se perdido.
    if (claimed.tries > 0) {
      let consulta: ConsultaCancelamentoResultado
      try {
        consulta = await sefin.consultarCancelamento({ tenant: claimed.tenant, chaveAcesso: claimed.chaveAcesso, certificado: cert })
      } catch (error) {
        consulta = { kind: 'unavailable', reason: errorText(error) }
      }
      if (consulta.kind === 'found') return await markCancelled(db, now, claimed.id, null, consulta.xml, cert)
      if (consulta.kind === 'unavailable') return await markRetrying(db, now, claimed.id, null, consulta.reason, cert)
    }

    const event = await db.query<{ id: string }>(
      `insert into nofiscal.fiscal_invoice_events (invoice_id, tipo, status, created_at) values ($1, 'e101101', 'sent', $2) returning id`,
      [claimed.id, now],
    )
    const eventId = event.rows[0].id
    let result: CancelarResultado
    try {
      result = await sefin.cancelar({ tenant: claimed.tenant, chaveAcesso: claimed.chaveAcesso, certificado: cert })
    } catch (error) {
      result = { kind: 'unavailable', reason: errorText(error) }
    }
    if (result.kind === 'accepted') return await markCancelled(db, now, claimed.id, eventId, result.xml, cert)
    if (result.kind === 'refused') return await markRefused(db, now, claimed.id, eventId, result.code, result.message, cert)
    return await markRetrying(db, now, claimed.id, eventId, result.reason, cert)
  } catch (error) {
    logEvent('nofiscal.cancel_failed', { invoice_id: claimed.id, error_name: error instanceof Error ? error.name : 'unknown' })
    return 'failed'
  }
}

async function markCancelled(
  db: Queryable,
  now: Date,
  id: string,
  eventId: string | null,
  xml: string,
  cert: Certificado,
): Promise<Outcome> {
  const safeXml = redactCertificate(xml, cert)
  if (eventId) {
    await db.query(`update nofiscal.fiscal_invoice_events set status = 'accepted', xml = $2, last_error_code = null where id = $1`, [
      eventId,
      safeXml,
    ])
  } else {
    // Achado pela consulta: o envio anterior chegou. Registra o aceite nele.
    await db.query(
      `update nofiscal.fiscal_invoice_events set status = 'accepted', xml = $2, last_error_code = null
        where id = (select id from nofiscal.fiscal_invoice_events where invoice_id = $1 and tipo = 'e101101'
                     order by created_at desc limit 1)`,
      [id, safeXml],
    )
  }
  await db.query(
    `update nofiscal.fiscal_invoices
        set status = 'cancelled', cancelled_at = $2, last_error_code = null, last_error = null,
            next_attempt_at = null, updated_at = $2
      where id = $1 and status = 'cancel_requested'`,
    [id, now],
  )
  logEvent('nofiscal.invoice_cancelled', { invoice_id: id })
  return 'cancelled'
}

async function markRefused(
  db: Queryable,
  now: Date,
  id: string,
  eventId: string | null,
  code: string,
  message: string,
  cert: Certificado,
): Promise<Outcome> {
  const safeCode = redactCertificate(code, cert, 100)
  if (eventId) {
    await db.query(`update nofiscal.fiscal_invoice_events set status = 'refused', last_error_code = $2 where id = $1`, [eventId, safeCode])
  }
  await db.query(
    `update nofiscal.fiscal_invoices
        set last_error_code = $2, last_error = $3, next_attempt_at = null, updated_at = $4
      where id = $1 and status = 'cancel_requested'`,
    [id, safeCode, redactCertificate(message, cert, MAX_ERROR_LENGTH), now],
  )
  logEvent('nofiscal.cancel_refused', { invoice_id: id })
  return 'refused'
}

async function markRetrying(
  db: Queryable,
  now: Date,
  id: string,
  eventId: string | null,
  reason: string,
  cert: Certificado,
): Promise<Outcome> {
  if (eventId) {
    await db.query(`update nofiscal.fiscal_invoice_events set last_error_code = 'SEFIN_UNAVAILABLE' where id = $1`, [eventId])
  }
  await db.query(
    `update nofiscal.fiscal_invoices
        set last_error_code = 'SEFIN_UNAVAILABLE', last_error = $2, updated_at = $3
      where id = $1 and status = 'cancel_requested'`,
    [id, redactCertificate(reason, cert, MAX_ERROR_LENGTH), now],
  )
  logEvent('nofiscal.cancel_retrying', { invoice_id: id })
  return 'retrying'
}
