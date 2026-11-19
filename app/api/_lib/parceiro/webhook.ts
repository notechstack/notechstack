// Webhook de retorno do parceiro (migração 20261119090000). Quando uma nota de qualquer empresa da conta chega a um
// estado final, o worker grava o evento em `nofiscal.fiscal_webhook_entregas` (retrato da nota naquele momento) e,
// na mesma rodada e nas seguintes, faz o POST na URL da conta-mãe, com reenvio e espera até a URL responder 2xx.
//
// Assinatura: `x-nofiscal-signature: sha256=<hex>`, o HMAC-SHA256 dos bytes exatos do corpo com o segredo da conta
// (Supabase Vault, `nofiscal.read_webhook_secret`). É o mesmo header do callback antigo, e o corpo mantém os campos
// antigos (`id`, `external_id`, `status`, `chave_acesso`, `last_error_code`) no topo. O corpo traz `enviado_em`
// (o receptor pode recusar evento velho) e `entrega_id` (o mesmo em todo reenvio, para deduplicar).
import { createHmac, randomUUID } from 'node:crypto'
import type { Queryable } from '../db.js'
import type { FinalStatus } from '../emission.js'
import { logEvent } from '../log.js'
import { visaoNfe, visaoNfse } from './visoes.js'

export const SIGNATURE_HEADER = 'x-nofiscal-signature'
/** Espera antes de cada reenvio, em minutos: 8 tentativas em cerca de 41 horas. */
export const ESPERAS_MINUTOS = [1, 5, 15, 60, 240, 720, 1440] as const
export const MAX_TENTATIVAS = ESPERAS_MINUTOS.length + 1
const TIMEOUT_MS = 10_000
/** Enquanto uma rodada entrega, a linha fica reservada por este tempo (outra rodada não a pega). */
const RESERVA_MINUTOS = 2

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number }>

export function assinar(corpo: string, segredo: string): string {
  return `sha256=${createHmac('sha256', segredo).update(corpo, 'utf8').digest('hex')}`
}

export type StatusNfe = 'authorized' | 'denied' | 'rejected' | 'cancelled'

export const EVENTO_NFSE: Record<FinalStatus, string> = {
  issued: 'nfse.emitida',
  rejected: 'nfse.recusada',
  cancelled: 'nfse.cancelada',
  cancel_refused: 'nfse.cancelamento_recusado',
}

export const EVENTO_NFE: Record<StatusNfe, string> = {
  authorized: 'nfe.autorizada',
  denied: 'nfe.denegada',
  rejected: 'nfe.rejeitada',
  cancelled: 'nfe.cancelada',
}

/** Conta-mãe da empresa da nota, se tiver URL de webhook. */
async function donoComWebhook(db: Queryable, tenantId: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `select d.id from nofiscal.fiscal_tenants t
       join nofiscal.fiscal_tenants d on d.id = coalesce(t.escritorio_tenant_id, t.id)
      where t.id = $1 and d.webhook_url is not null`,
    [tenantId],
  )
  return rows[0]?.id ?? null
}

async function gravar(db: Queryable, donoId: string, recurso: 'nfse' | 'nfe', documentoId: string, evento: string, dados: unknown): Promise<boolean> {
  const { rowCount } = await db.query(
    `insert into nofiscal.fiscal_webhook_entregas (dono_tenant_id, recurso, documento_id, evento, dados)
     values ($1, $2, $3, $4, $5::jsonb)
     on conflict (documento_id, evento) do nothing`,
    [donoId, recurso, documentoId, evento, JSON.stringify(dados)],
  )
  return rowCount === 1
}

/** Evento de NFS-e para o webhook. Sem URL na conta-mãe, nada é gravado. Uma vez por nota e evento. */
export async function enfileirarNfse(db: Queryable, invoiceId: string, status: FinalStatus): Promise<boolean> {
  const visao = await visaoNfse(db, invoiceId)
  if (!visao) return false
  const { rows } = await db.query<{ tenant_id: string }>('select tenant_id from nofiscal.fiscal_invoices where id = $1', [invoiceId])
  const dono = rows[0] ? await donoComWebhook(db, rows[0].tenant_id) : null
  if (!dono) return false
  return gravar(db, dono, 'nfse', invoiceId, EVENTO_NFSE[status], visao)
}

/** Evento de NF-e para o webhook. */
export async function enfileirarNfe(db: Queryable, nfeId: string, status: StatusNfe): Promise<boolean> {
  const visao = await visaoNfe(db, nfeId)
  if (!visao) return false
  const { rows } = await db.query<{ tenant_id: string }>('select tenant_id from nofiscal.fiscal_nfe where id = $1', [nfeId])
  const dono = rows[0] ? await donoComWebhook(db, rows[0].tenant_id) : null
  if (!dono) return false
  return gravar(db, dono, 'nfe', nfeId, EVENTO_NFE[status], visao)
}

export function corpoDoEvento(e: { id: string; evento: string; recurso: string; dados: Record<string, unknown> }, agora: Date): string {
  return JSON.stringify({ evento: e.evento, recurso: e.recurso, entrega_id: e.id, enviado_em: agora.toISOString(), ...e.dados })
}

type Envio = { ok: true; http: number } | { ok: false; http: number | null; erro: string }

async function postar(fetch: FetchLike, url: string, segredo: string, corpo: string, extra: Record<string, string>): Promise<Envio> {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'nofiscal-webhook/1', [SIGNATURE_HEADER]: assinar(corpo, segredo), ...extra },
      body: corpo,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    return r.ok ? { ok: true, http: r.status } : { ok: false, http: r.status, erro: `HTTP ${r.status}` }
  } catch (error) {
    return { ok: false, http: null, erro: error instanceof Error && error.name === 'TimeoutError' ? 'tempo esgotado' : 'falha de conexão' }
  }
}

export type ResumoWebhooks = { entregues: number; reagendadas: number; desistidas: number }

export type EntregaDeps = { db: Queryable; fetch: FetchLike; now: () => Date; limite?: number; donoId?: string }

/** Entrega os eventos pendentes cuja hora chegou. Cada falha reagenda só aquela entrega. */
export async function entregarWebhooks(deps: EntregaDeps): Promise<ResumoWebhooks> {
  const agora = deps.now()
  const resumo: ResumoWebhooks = { entregues: 0, reagendadas: 0, desistidas: 0 }
  const { rows } = await deps.db.query<{
    id: string
    dono_tenant_id: string
    evento: string
    recurso: string
    dados: Record<string, unknown>
    tentativas: number
  }>(
    `update nofiscal.fiscal_webhook_entregas e
        set proxima_em = $1::timestamptz + make_interval(mins => $3), updated_at = $1
      where e.id in (select x.id from nofiscal.fiscal_webhook_entregas x
                      -- greatest: o evento gravado agora (now() do banco) sai nesta rodada mesmo que o relógio do
                      -- banco esteja um pouco à frente do da função.
                      where x.status = 'pendente' and x.proxima_em <= greatest($1::timestamptz, now())
                        and ($4::uuid is null or x.dono_tenant_id = $4)
                      order by x.proxima_em
                      limit $2
                      for update skip locked)
      returning e.id, e.dono_tenant_id, e.evento, e.recurso, e.dados, e.tentativas`,
    [agora, deps.limite ?? 50, RESERVA_MINUTOS, deps.donoId ?? null],
  )
  for (const e of rows) {
    const destino = await deps.db.query<{ url: string | null; segredo: string | null }>(
      'select t.webhook_url as url, nofiscal.read_webhook_secret(t.id) as segredo from nofiscal.fiscal_tenants t where t.id = $1',
      [e.dono_tenant_id],
    )
    const { url, segredo } = destino.rows[0] ?? { url: null, segredo: null }
    const tentativa = e.tentativas + 1
    if (!url || !segredo) {
      await deps.db.query(
        `update nofiscal.fiscal_webhook_entregas set status = 'desistiu', ultimo_erro = $2, updated_at = $3 where id = $1`,
        [e.id, url ? 'conta sem segredo do webhook' : 'conta sem URL de webhook', agora],
      )
      resumo.desistidas++
      continue
    }
    const corpo = corpoDoEvento(e, agora)
    const r = await postar(deps.fetch, url, segredo, corpo, {
      'x-nofiscal-evento': e.evento,
      'x-nofiscal-entrega': e.id,
      'x-nofiscal-tentativa': String(tentativa),
    })
    if (r.ok) {
      await deps.db.query(
        `update nofiscal.fiscal_webhook_entregas
            set status = 'entregue', tentativas = $2, ultimo_http = $3, ultimo_erro = null, entregue_em = $4, updated_at = $4
          where id = $1`,
        [e.id, tentativa, r.http, agora],
      )
      logEvent('nofiscal.webhook_entregue', { entrega_id: e.id, evento: e.evento, tentativa })
      resumo.entregues++
      continue
    }
    const desiste = tentativa >= MAX_TENTATIVAS
    const espera = ESPERAS_MINUTOS[Math.min(tentativa, ESPERAS_MINUTOS.length) - 1]
    await deps.db.query(
      `update nofiscal.fiscal_webhook_entregas
          set status = $2, tentativas = $3, ultimo_http = $4, ultimo_erro = $5,
              proxima_em = $6::timestamptz + make_interval(mins => $7), updated_at = $6
        where id = $1`,
      [e.id, desiste ? 'desistiu' : 'pendente', tentativa, r.http, r.erro, agora, espera],
    )
    logEvent('nofiscal.webhook_falhou', { entrega_id: e.id, evento: e.evento, tentativa, http_status: r.http ?? 0, desistiu: desiste })
    if (desiste) resumo.desistidas++
    else resumo.reagendadas++
  }
  return resumo
}

/** Teste do painel: um evento `teste`, assinado como os outros, uma tentativa só, sem gravar na fila. */
export async function testarWebhook(db: Queryable, fetch: FetchLike, donoId: string, agora: Date): Promise<Envio | { ok: false; http: null; erro: string }> {
  const { rows } = await db.query<{ url: string | null; segredo: string | null }>(
    'select t.webhook_url as url, nofiscal.read_webhook_secret(t.id) as segredo from nofiscal.fiscal_tenants t where t.id = $1',
    [donoId],
  )
  const { url, segredo } = rows[0] ?? { url: null, segredo: null }
  if (!url || !segredo) return { ok: false, http: null, erro: 'cadastre a URL do webhook antes de testar' }
  const id = randomUUID()
  const corpo = JSON.stringify({ evento: 'teste', recurso: 'teste', entrega_id: id, enviado_em: agora.toISOString() })
  return postar(fetch, url, segredo, corpo, { 'x-nofiscal-evento': 'teste', 'x-nofiscal-entrega': id, 'x-nofiscal-tentativa': '1' })
}

/** Reenvio manual pelo painel: a entrega volta à fila agora, com as tentativas zeradas. */
export async function reenviarEntrega(db: Queryable, donoId: string, entregaId: string, agora: Date): Promise<boolean> {
  const { rowCount } = await db.query(
    `update nofiscal.fiscal_webhook_entregas
        set status = 'pendente', tentativas = 0, proxima_em = $3, ultimo_erro = null, updated_at = $3
      where id = $1 and dono_tenant_id = $2 and status in ('desistiu', 'entregue')`,
    [entregaId, donoId, agora],
  )
  return rowCount === 1
}
