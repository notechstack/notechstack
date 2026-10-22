// Interface do cliente da Sefin Nacional (forma no Landing do checklist, lote 2a, e o método
// `consultarCancelamento` do lote 2b). A implementação real (leiaute da DPS, assinatura
// XMLDSig, mTLS, URL por ambiente) está em `sefin-client.ts`; o motor só conhece esta interface.

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
  /** `totTrib/pTotTribSN` da DPS (Landing, lote 2b); `numeric` chega do `pg` como texto. */
  p_tot_trib_sn: string | null
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

export type ConsultaCancelamentoResultado =
  | { kind: 'found'; xml: string }
  | { kind: 'not_found' }
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
  /** Evento e101101 já registrado? Consultado antes de retransmitir o cancelamento. */
  consultarCancelamento(input: {
    tenant: SefinTenant
    chaveAcesso: string
    certificado: Certificado
  }): Promise<ConsultaCancelamentoResultado>
}
