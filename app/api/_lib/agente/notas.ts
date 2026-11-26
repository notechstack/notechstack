// Notas vistas pelo agente: o número que a pessoa lê e o que vai no payload do motor
// (Landing, lote B - conversa: número exibido e payload gravado).
import { parseNfseXml } from '../nfse-xml.js'
import { locacaoNoPayload, type Locacao } from '../locacao.js'
import { obraNoPayload, type Obra } from '../obra.js'
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
/**
 * `municipio_prestacao_ibge`: local da prestação (local-prestacao.ts); ausente ou `null` = município da empresa.
 * `obra`: CNO ou endereço da obra (obra.ts), obrigatório nos códigos de construção civil (E0370).
 */
export type ServicoDoPedido = {
  codigo: string
  descricao: string
  municipio_prestacao_ibge?: string | null
  obra?: Obra | null
  /** Imóvel ou bens móveis (locacao.ts), nos códigos de locação 99.03.01 e 99.04.01. */
  locacao?: Locacao | null
}

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
    servico: {
      codigo_servico_nacional: servico.codigo,
      descricao: servico.descricao,
      ...(servico.municipio_prestacao_ibge ? { municipio_prestacao_ibge: servico.municipio_prestacao_ibge } : {}),
      ...(servico.obra ? { obra: obraNoPayload(servico.obra) } : {}),
      ...(servico.locacao ? { locacao: locacaoNoPayload(servico.locacao) } : {}),
    },
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
