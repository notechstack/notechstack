// Pedidos à Sefaz da NF-e (leiaute 4.00): lote de autorização, consulta de recibo, consulta por chave, status,
// eventos (cancelamento 110111 e carta de correção 110110, leiaute de evento 1.00) e inutilização. Os elementos
// com Id (`infEvento`, `infInut`) saem sem assinatura; quem chama assina antes de embrulhar no lote.
import { el, leaf } from '../xml.js'
import { CODIGO_UF, TP_AMB, type AmbienteNfe, type Uf } from './autorizadores.js'
import { dataHoraBrasilia, NS_NFE, soDigitos, VERSAO_NFE } from './nfe-builder.js'

/** Texto fixo exigido pelo XSD do evento 110110 (versão sem acentos, aceita por todas as UFs). */
export const CONDICAO_DE_USO_CCE =
  'A Carta de Correcao e disciplinada pelo paragrafo 1o-A do art. 7o do Convenio S/N, de 15 de dezembro de 1970 e pode ser utilizada para regularizacao de erro ocorrido na emissao de documento fiscal, desde que o erro nao esteja relacionado com: I - as variaveis que determinam o valor do imposto tais como: base de calculo, aliquota, diferenca de preco, quantidade, valor da operacao ou da prestacao; II - a correcao de dados cadastrais que implique mudanca do remetente ou do destinatario; III - a data de emissao ou de saida.'

export class PedidoInvalidoError extends Error {
  readonly code = 'PEDIDO_INVALIDO'
  constructor(message: string) {
    super(message)
    this.name = 'PedidoInvalidoError'
  }
}

const txt = (s: string) => s.replace(/\s+/g, ' ').trim()

/** idLote de até 15 dígitos, derivado do relógio (único o bastante por emitente). */
export const novoIdLote = (agora = Date.now()) => String(agora).slice(-15)

/** Lote síncrono de uma NF-e já assinada (`<NFe>…<Signature/></NFe>`). */
export function loteAutorizacao(nfeAssinada: string, idLote: string): string {
  if (!/^\d{1,15}$/.test(idLote)) throw new PedidoInvalidoError('idLote deve ter de 1 a 15 dígitos')
  // A declaração de namespace do <NFe> continua no filho: o c14n da assinatura não muda (mesmo namespace padrão).
  return `<enviNFe xmlns="${NS_NFE}" versao="${VERSAO_NFE}"><idLote>${idLote}</idLote><indSinc>1</indSinc>${nfeAssinada}</enviNFe>`
}

export const consultaRecibo = (ambiente: AmbienteNfe, recibo: string) =>
  el('consReciNFe', [leaf('tpAmb', TP_AMB[ambiente]), leaf('nRec', soDigitos(recibo))], { xmlns: NS_NFE, versao: VERSAO_NFE })

export const consultaChave = (ambiente: AmbienteNfe, chave: string) =>
  el('consSitNFe', [leaf('tpAmb', TP_AMB[ambiente]), leaf('xServ', 'CONSULTAR'), leaf('chNFe', chave)], {
    xmlns: NS_NFE,
    versao: VERSAO_NFE,
  })

export const consultaStatus = (ambiente: AmbienteNfe, uf: Uf) =>
  el('consStatServ', [leaf('tpAmb', TP_AMB[ambiente]), leaf('cUF', CODIGO_UF[uf]), leaf('xServ', 'STATUS')], {
    xmlns: NS_NFE,
    versao: VERSAO_NFE,
  })

export type EventoBase = {
  ambiente: AmbienteNfe
  uf: Uf
  cnpj: string
  chave: string
  quando: Date
  /** 1 no primeiro evento do tipo; a CC-e aceita até 20 (cada nova substitui a anterior). */
  sequencia?: number
}

export type PedidoEvento = { xml: string; id: string; tipo: '110111' | '110110' }

function evento(base: EventoBase, tipo: '110111' | '110110', detalhe: (string | null)[]): PedidoEvento {
  if (!/^\d{44}$/.test(base.chave)) throw new PedidoInvalidoError('chave de acesso deve ter 44 dígitos')
  const seq = base.sequencia ?? 1
  if (!(seq >= 1 && seq <= 20)) throw new PedidoInvalidoError('sequência do evento de 1 a 20')
  const id = `ID${tipo}${base.chave}${String(seq).padStart(2, '0')}`
  const xml = el(
    'evento',
    el(
      'infEvento',
      [
        leaf('cOrgao', CODIGO_UF[base.uf]),
        leaf('tpAmb', TP_AMB[base.ambiente]),
        leaf('CNPJ', soDigitos(base.cnpj)),
        leaf('chNFe', base.chave),
        leaf('dhEvento', dataHoraBrasilia(base.quando)),
        leaf('tpEvento', tipo),
        leaf('nSeqEvento', String(seq)),
        leaf('verEvento', '1.00'),
        el('detEvento', detalhe, { versao: '1.00' }),
      ],
      { Id: id },
    ),
    { xmlns: NS_NFE, versao: '1.00' },
  )
  return { xml, id, tipo }
}

export function pedidoCancelamento(base: EventoBase & { protocolo: string; justificativa: string }): PedidoEvento {
  const just = txt(base.justificativa)
  if (just.length < 15 || just.length > 255) throw new PedidoInvalidoError('justificativa do cancelamento de 15 a 255 caracteres')
  if (!/^\d{15}$/.test(soDigitos(base.protocolo))) throw new PedidoInvalidoError('protocolo de autorização deve ter 15 dígitos')
  return evento({ ...base, sequencia: 1 }, '110111', [
    leaf('descEvento', 'Cancelamento'),
    leaf('nProt', soDigitos(base.protocolo)),
    leaf('xJust', just),
  ])
}

export function pedidoCartaCorrecao(base: EventoBase & { correcao: string }): PedidoEvento {
  const correcao = txt(base.correcao)
  if (correcao.length < 15 || correcao.length > 1000) throw new PedidoInvalidoError('texto da carta de correção de 15 a 1000 caracteres')
  return evento(base, '110110', [
    leaf('descEvento', 'Carta de Correcao'),
    leaf('xCorrecao', correcao),
    leaf('xCondUso', CONDICAO_DE_USO_CCE),
  ])
}

/** Lote de eventos com o `<evento>` já assinado. */
export function loteEvento(eventoAssinado: string, idLote: string): string {
  return `<envEvento xmlns="${NS_NFE}" versao="1.00"><idLote>${idLote}</idLote>${eventoAssinado}</envEvento>`
}

export type PedidoInutilizacao = { xml: string; id: string }

export function pedidoInutilizacao(p: {
  ambiente: AmbienteNfe
  uf: Uf
  cnpj: string
  ano: number
  serie: number
  inicio: number
  fim: number
  justificativa: string
}): PedidoInutilizacao {
  const just = txt(p.justificativa)
  if (just.length < 15 || just.length > 255) throw new PedidoInvalidoError('justificativa da inutilização de 15 a 255 caracteres')
  if (!(p.inicio >= 1 && p.fim >= p.inicio && p.fim <= 999_999_999)) throw new PedidoInvalidoError('faixa de numeração inválida')
  const aa = String(p.ano % 100).padStart(2, '0')
  const cnpj = soDigitos(p.cnpj)
  const id =
    `ID${CODIGO_UF[p.uf]}${aa}${cnpj}55${String(p.serie).padStart(3, '0')}` +
    `${String(p.inicio).padStart(9, '0')}${String(p.fim).padStart(9, '0')}`
  const xml = el(
    'inutNFe',
    el(
      'infInut',
      [
        leaf('tpAmb', TP_AMB[p.ambiente]),
        leaf('xServ', 'INUTILIZAR'),
        leaf('cUF', CODIGO_UF[p.uf]),
        leaf('ano', aa),
        leaf('CNPJ', cnpj),
        leaf('mod', '55'),
        leaf('serie', String(p.serie)),
        leaf('nNFIni', String(p.inicio)),
        leaf('nNFFin', String(p.fim)),
        leaf('xJust', just),
      ],
      { Id: id },
    ),
    { xmlns: NS_NFE, versao: VERSAO_NFE },
  )
  return { xml, id }
}
