// O que a API pública e o webhook mostram de uma nota (NFS-e e NF-e). A mesma forma nos dois lugares: o corpo do
// webhook é a visão da nota no momento do evento. Campos antigos da NFS-e (`id`, `external_id`, `status`,
// `chave_acesso`, `last_error_code`) ficam com o mesmo nome do callback antigo.
import type { Queryable } from '../db.js'
import { numeroDaNota } from '../agente/notas.js'

export type VisaoNfse = {
  id: string
  external_id: string
  status: string
  cnpj_prestador: string
  numero: string | null
  numero_dps: string | null
  chave_acesso: string | null
  valor: string | null
  tomador_documento: string | null
  last_error_code: string | null
  last_error: string | null
  origem: 'api' | 'outra'
  criada_em: string
  emitida_em: string | null
  cancelada_em: string | null
}

type LinhaNfse = {
  id: string
  external_id: string
  status: string
  cnpj: string
  dps_numero: string | null
  xml_nfse: string | null
  chave_acesso: string | null
  payload: { valor?: unknown; tomador?: { cpf?: string; cnpj?: string } } | null
  last_error_code: string | null
  last_error: string | null
  origem: string | null
  created_at: Date
  issued_at: Date | null
  cancelled_at: Date | null
}

const SELECT_NFSE = `select i.id, i.external_id, i.status, t.cnpj, i.dps_numero::text as dps_numero, i.xml_nfse, i.chave_acesso,
                            i.payload, i.last_error_code, i.last_error, i.origem, i.created_at, i.issued_at, i.cancelled_at
                       from nofiscal.fiscal_invoices i
                       join nofiscal.fiscal_tenants t on t.id = i.tenant_id`

const iso = (d: Date | null) => (d ? d.toISOString() : null)
const COM_NUMERO = ['issued', 'cancel_requested', 'cancelled']

function visaoDaLinha(r: LinhaNfse): VisaoNfse {
  const tomador = r.payload?.tomador
  return {
    id: r.id,
    external_id: r.external_id,
    status: r.status,
    cnpj_prestador: r.cnpj,
    numero: COM_NUMERO.includes(r.status) && r.xml_nfse ? numeroDaNota({ xml_nfse: r.xml_nfse, dps_numero: r.dps_numero }) : null,
    numero_dps: r.dps_numero,
    chave_acesso: r.chave_acesso,
    valor: typeof r.payload?.valor === 'string' ? r.payload.valor : null,
    tomador_documento: tomador?.cpf ?? tomador?.cnpj ?? null,
    last_error_code: r.last_error_code,
    last_error: r.last_error,
    origem: r.origem === 'api' ? 'api' : 'outra',
    criada_em: r.created_at.toISOString(),
    emitida_em: iso(r.issued_at),
    cancelada_em: iso(r.cancelled_at),
  }
}

/** NFS-e de uma empresa da conta (`donoId`); sem `donoId`, a nota por id (worker). */
export async function visaoNfse(db: Queryable, id: string, donoId?: string): Promise<VisaoNfse | null> {
  const { rows } = donoId
    ? await db.query<LinhaNfse>(`${SELECT_NFSE} where i.id = $1 and i.tenant_id in (select nofiscal.empresas_do_dono($2))`, [id, donoId])
    : await db.query<LinhaNfse>(`${SELECT_NFSE} where i.id = $1`, [id])
  return rows[0] ? visaoDaLinha(rows[0]) : null
}

/** NFS-e pelo `external_id` de uma empresa (a idempotência é por empresa). */
export async function visaoNfsePorExternalId(db: Queryable, tenantId: string, externalId: string): Promise<VisaoNfse | null> {
  const { rows } = await db.query<LinhaNfse>(`${SELECT_NFSE} where i.tenant_id = $1 and i.external_id = $2`, [tenantId, externalId])
  return rows[0] ? visaoDaLinha(rows[0]) : null
}

export type VisaoNfe = {
  id: string
  external_id: string
  status: string
  cnpj_emitente: string
  serie: number
  numero: number
  chave: string | null
  protocolo: string | null
  valor_total: string
  destinatario_documento: string
  ambiente: string
  last_error_code: string | null
  last_error: string | null
  origem: string
  criada_em: string
  autorizada_em: string | null
  cancelada_em: string | null
}

type LinhaNfe = Omit<VisaoNfe, 'numero' | 'criada_em' | 'autorizada_em' | 'cancelada_em' | 'cnpj_emitente'> & {
  cnpj: string
  numero: string
  created_at: Date
  authorized_at: Date | null
  cancelled_at: Date | null
}

const SELECT_NFE = `select n.id, n.external_id, n.status, t.cnpj, n.serie, n.numero::text as numero, n.chave, n.protocolo,
                           n.valor_total::text as valor_total, n.destinatario_documento, n.ambiente, n.last_error_code, n.last_error,
                           n.origem, n.created_at, n.authorized_at, n.cancelled_at
                      from nofiscal.fiscal_nfe n
                      join nofiscal.fiscal_tenants t on t.id = n.tenant_id`

function visaoDaNfe(r: LinhaNfe): VisaoNfe {
  return {
    id: r.id,
    external_id: r.external_id,
    status: r.status,
    cnpj_emitente: r.cnpj,
    serie: r.serie,
    numero: Number(r.numero),
    chave: r.chave,
    protocolo: r.protocolo,
    valor_total: r.valor_total,
    destinatario_documento: r.destinatario_documento,
    ambiente: r.ambiente,
    last_error_code: r.last_error_code,
    last_error: r.last_error,
    origem: r.origem,
    criada_em: r.created_at.toISOString(),
    autorizada_em: iso(r.authorized_at),
    cancelada_em: iso(r.cancelled_at),
  }
}

export async function visaoNfe(db: Queryable, id: string, donoId?: string): Promise<VisaoNfe | null> {
  const { rows } = donoId
    ? await db.query<LinhaNfe>(`${SELECT_NFE} where n.id = $1 and n.tenant_id in (select nofiscal.empresas_do_dono($2))`, [id, donoId])
    : await db.query<LinhaNfe>(`${SELECT_NFE} where n.id = $1`, [id])
  return rows[0] ? visaoDaNfe(rows[0]) : null
}

export async function visaoNfePorExternalId(db: Queryable, tenantId: string, externalId: string): Promise<VisaoNfe | null> {
  const { rows } = await db.query<LinhaNfe>(`${SELECT_NFE} where n.tenant_id = $1 and n.external_id = $2`, [tenantId, externalId])
  return rows[0] ? visaoDaNfe(rows[0]) : null
}
