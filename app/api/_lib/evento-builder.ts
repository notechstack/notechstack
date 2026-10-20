// Pedido de registro do evento de cancelamento e101101 (§5 da referência; Landing do
// checklist, lote 2b - cancelamento). Assina-se `infPedReg`, com o mesmo perfil da DPS.
import { DH_EMI_SKEW_MS, formatDhSaoPaulo, LEIAUTE_VERSAO, NFSE_NAMESPACE, tpAmbOf, VER_APLIC } from './dps-builder.js'
import type { SefinTenant } from './sefin.js'
import { el, leaf } from './xml.js'

export const CANCELAMENTO_TIPO = '101101'
/** 9 = Outros (1 = Erro na Emissão; 2 = Serviço não Prestado). A confirmar com a contadora. */
export const CANCELAMENTO_MOTIVO = '9'
export const CANCELAMENTO_X_MOTIVO = 'Pagamento da venda estornado ao tomador; servico desfeito.'

export function buildIdPedRegEvento(chaveAcesso: string): string {
  if (!/^\d{50}$/.test(chaveAcesso)) throw new Error('chave de acesso deve ter 50 dígitos')
  return `PRE${chaveAcesso}${CANCELAMENTO_TIPO}`
}

export function buildPedidoCancelamento(input: { tenant: SefinTenant; chaveAcesso: string; now: Date }): {
  id: string
  xml: string
} {
  const id = buildIdPedRegEvento(input.chaveAcesso)
  const infPedReg = el(
    'infPedReg',
    [
      leaf('tpAmb', tpAmbOf(input.tenant)),
      leaf('verAplic', VER_APLIC),
      leaf('dhEvento', formatDhSaoPaulo(new Date(input.now.getTime() - DH_EMI_SKEW_MS))),
      leaf('CNPJAutor', input.tenant.cnpj),
      leaf('chNFSe', input.chaveAcesso),
      el('e101101', [
        leaf('xDesc', 'Cancelamento de NFS-e'),
        leaf('cMotivo', CANCELAMENTO_MOTIVO),
        leaf('xMotivo', CANCELAMENTO_X_MOTIVO),
      ]),
    ],
    { Id: id },
  )
  return { id, xml: el('pedRegEvento', infPedReg, { xmlns: NFSE_NAMESPACE, versao: LEIAUTE_VERSAO }) }
}
