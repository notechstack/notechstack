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
 * `tomador` `null` = tomador não informado (tomador-nao-informado.ts): o payload leva `tomador_nao_informado: true` e
 * nenhum tomador (nem endereço). `retencao` entra apenas quando há retenção; `endereco` do tomador, sempre que houver (endereco-tomador.ts: o informado
 * ou o da Receita, em toda nota, não só com ISS retido); `informacoes_complementares`, só quando há texto.
 */
export function payloadDaNota(
  tomador: TomadorDoPedido | null,
  servico: ServicoDoPedido,
  valor: string,
  extra: { retencao?: Retencao | null; endereco?: EnderecoNacional | null; informacoes_complementares?: string | null } = {},
) {
  const retencao = extra.retencao && (extra.retencao.iss || extra.retencao.inss) ? extra.retencao : null
  return {
    ...(tomador
      ? {
          tomador: {
            [tipoDoDocumento(tomador.documento)]: tomador.documento,
            nome: tomador.nome,
            ...(tomador.email ? { email: tomador.email } : {}),
            ...(extra.endereco ? { endereco: extra.endereco } : {}),
          },
        }
      : { tomador_nao_informado: true as const }),
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

type PayloadLido = {
  tomador?: { cpf?: string; cnpj?: string; nome?: string; email?: string }
  tomador_nao_informado?: boolean
  valor?: string
}

/** Nome que a pessoa lê para a nota sem tomador (mensagens, e-mail, lista de notas). */
export const NOME_DA_NOTA_SEM_TOMADOR = 'consumidor não identificado'

/** Nota do payload sem tomador (`tomador_nao_informado: true`). */
export const semTomadorNoPayload = (payload: unknown): boolean =>
  typeof payload === 'object' && payload !== null && (payload as PayloadLido).tomador_nao_informado === true

export function lerPayload(payload: unknown): {
  documento: string | null
  nome: string
  email: string | null
  valor: string | null
  semTomador: boolean
} {
  const p = (typeof payload === 'object' && payload !== null ? payload : {}) as PayloadLido
  const semTomador = p.tomador_nao_informado === true
  return {
    semTomador,
    documento: p.tomador?.cpf ?? p.tomador?.cnpj ?? null,
    nome: p.tomador?.nome ?? (semTomador ? NOME_DA_NOTA_SEM_TOMADOR : 'tomador'),
    email: p.tomador?.email ?? null,
    valor: typeof p.valor === 'string' ? p.valor : null,
  }
}
