// Interface do cliente da Sefin Nacional. A implementação (layout da DPS, assinatura
// XMLDSig, mTLS, URL por ambiente) é do lote 2b e depende do spike (Unresolved 1–3):
// nada aqui assume formato de XML, URL ou resposta da Sefin. Forma no Landing do checklist.

export type Ambiente = 'producao_restrita' | 'producao'

/** PFX e senha do A1, lidos de `nofiscal.read_certificate` só durante a chamada (critério 22). */
export type Certificado = { pfxBase64: string; password: string }

export type SefinTenant = {
  id: string
  cnpj: string
  razao_social: string
  inscricao_municipal: string | null
  codigo_municipio_ibge: string
  regime: string
  ambiente: Ambiente
}

export type SefinInvoice = {
  id: string
  external_id: string
  payload: unknown
  dps_serie: string
  dps_numero: number
  id_dps: string
}

export type EmitirResultado =
  | { kind: 'authorized'; chaveAcesso: string; xmlDps: string; xmlNfse: string }
  | { kind: 'rejected'; code: string; message: string }
  | { kind: 'unavailable'; reason: string }

export type ConsultaResultado =
  | { kind: 'found'; chaveAcesso: string; xmlNfse: string }
  | { kind: 'not_found' }
  | { kind: 'unavailable'; reason: string }

export type CancelarResultado =
  | { kind: 'accepted'; xml: string }
  | { kind: 'refused'; code: string; message: string }
  | { kind: 'unavailable'; reason: string }

export interface SefinClient {
  /** Id da DPS no formato do layout nacional; calculado antes de transmitir, para a consulta (critério 10). */
  idDps(input: { tenant: SefinTenant; serie: string; numero: number }): string
  emitir(input: { tenant: SefinTenant; invoice: SefinInvoice; certificado: Certificado }): Promise<EmitirResultado>
  consultarPorIdDps(input: { tenant: SefinTenant; idDps: string; certificado: Certificado }): Promise<ConsultaResultado>
  cancelar(input: {
    tenant: SefinTenant
    chaveAcesso: string
    certificado: Certificado
  }): Promise<CancelarResultado>
}

/** Até o lote 2b entregar o cliente real, o worker não transmite nada e responde 503. */
export function sefinClientFromEnv(): SefinClient | null {
  return null
}
