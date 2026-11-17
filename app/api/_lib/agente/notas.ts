// Notas vistas pelo agente: o número que a pessoa lê e o que vai no payload do motor
// (Landing, lote B - conversa: número exibido e payload gravado).
import { parseNfseXml } from '../nfse-xml.js'
import type { EnderecoNacional, Retencao } from '../retencao.js'
import { tipoDoDocumento } from './documentos.js'

/** `nNFSe` do XML da NFS-e; sem XML legível, o número da DPS. */
export function numeroDaNota(nota: { xml_nfse: string | null; dps_numero: string | number | null }): string {
  if (nota.xml_nfse) {
    try {
      const numero = parseNfseXml(nota.xml_nfse).nNFSe
      if (numero) return numero
    } catch {
      // XML que o leitor do DANFSe não reconhece: cai no número da DPS.
    }
  }
  return nota.dps_numero === null ? '?' : String(nota.dps_numero)
}

export type TomadorDoPedido = { documento: string; nome: string; email: string | null }
export type ServicoDoPedido = { codigo: string; descricao: string }

/**
 * `retencao` e `endereco` (só com ISS retido, E0237) entram apenas quando há retenção, e `informacoes_complementares`
 * só quando há texto: sem eles, a nota tem o mesmo payload de antes.
 */
export function payloadDaNota(
  tomador: TomadorDoPedido,
  servico: ServicoDoPedido,
  valor: string,
  extra: { retencao?: Retencao | null; endereco?: EnderecoNacional | null; informacoes_complementares?: string | null } = {},
) {
  const retencao = extra.retencao && (extra.retencao.iss || extra.retencao.inss) ? extra.retencao : null
  return {
    tomador: {
      [tipoDoDocumento(tomador.documento)]: tomador.documento,
      nome: tomador.nome,
      ...(tomador.email ? { email: tomador.email } : {}),
      ...(retencao?.iss && extra.endereco ? { endereco: extra.endereco } : {}),
    },
    servico: { codigo_servico_nacional: servico.codigo, descricao: servico.descricao },
    valor,
    ...(retencao ? { retencao } : {}),
    ...(extra.informacoes_complementares ? { informacoes_complementares: extra.informacoes_complementares } : {}),
  }
}

type PayloadLido = { tomador?: { cpf?: string; cnpj?: string; nome?: string; email?: string }; valor?: string }

export function lerPayload(payload: unknown): { documento: string | null; nome: string; email: string | null; valor: string | null } {
  const p = (typeof payload === 'object' && payload !== null ? payload : {}) as PayloadLido
  return {
    documento: p.tomador?.cpf ?? p.tomador?.cnpj ?? null,
    nome: p.tomador?.nome ?? 'tomador',
    email: p.tomador?.email ?? null,
    valor: typeof p.valor === 'string' ? p.valor : null,
  }
}
