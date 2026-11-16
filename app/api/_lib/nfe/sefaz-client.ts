// Cliente SOAP 1.2 das Sefaz da NF-e (27 UFs, pelos autorizadores de autorizadores.ts). mTLS e assinatura com o A1
// do próprio emitente: a raiz do CNPJ do certificado tem de ser a do emitente (rejeição 213), então nunca é o
// certificado do escritório nem o da nó (memória no-nunca-assina-nota-de-cliente). O servidor é verificado pelas
// CAs do Node mais as raízes da ICP-Brasil. Nada do certificado é gravado ou logado aqui.
import { DOMParser } from '@xmldom/xmldom'
import forge from 'node-forge'
import { CertificateError, pfxToPem, type PemCredentials } from '../pfx.js'
import { httpsTransport, type HttpResponse, type SefinTransport } from '../sefin-client.js'
import type { Certificado } from '../sefin.js'
import { signXml } from '../xml-signer.js'
import { destino, type AmbienteNfe, type ServicoNfe, type Uf } from './autorizadores.js'
import { RAIZES_ICP_BRASIL } from './icp-brasil.js'
import { NS_NFE, VERSAO_NFE } from './nfe-builder.js'
import {
  consultaChave,
  consultaRecibo,
  consultaStatus,
  loteAutorizacao,
  loteEvento,
  novoIdLote,
  type PedidoEvento,
  type PedidoInutilizacao,
} from './pedidos.js'

const WSDL = 'http://www.portalfiscal.inf.br/nfe/wsdl'
const SOAP12 = 'http://www.w3.org/2003/05/soap-envelope'

/** Transporte padrão: o mesmo `node:https` da Sefin, com as raízes da ICP-Brasil. */
export const sefazTransport = (timeoutMs = 30_000): SefinTransport => httpsTransport({ timeoutMs, extraCa: [...RAIZES_ICP_BRASIL] })

export function envelope(operacao: string, corpo: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap12:Envelope xmlns:soap12="${SOAP12}"><soap12:Body>` +
    `<nfeDadosMsg xmlns="${WSDL}/${operacao}">${corpo}</nfeDadosMsg>` +
    `</soap12:Body></soap12:Envelope>`
  )
}

// --- leitura das respostas -------------------------------------------------------------------------------------

type El = Element

function parse(xml: string): Document | null {
  try {
    let erro = false
    const marcar = () => {
      erro = true
    }
    const doc = new DOMParser({ errorHandler: { error: marcar, fatalError: marcar } }).parseFromString(xml, 'text/xml')
    return erro ? null : (doc as unknown as Document)
  } catch {
    return null
  }
}
const first = (node: Document | El, name: string): El | null =>
  (node.getElementsByTagNameNS(NS_NFE, name)[0] as El | undefined) ??
  (node.getElementsByTagName(name)[0] as El | undefined) ??
  null
const text = (node: Document | El | null, name: string): string => (node ? (first(node, name)?.textContent ?? '').trim() : '')

/** Trecho original de um elemento, sem reserializar (o protocolo vai assim para o nfeProc). */
function trecho(xml: string, tag: string): string | null {
  const ini = xml.search(new RegExp(`<(?:\\w+:)?${tag}[\\s>]`))
  if (ini < 0) return null
  const fechamento = new RegExp(`</(?:\\w+:)?${tag}>`, 'g')
  fechamento.lastIndex = ini
  const fim = fechamento.exec(xml)
  return fim ? xml.slice(ini, fim.index + fim[0].length) : null
}

/** Autorizada (100) ou autorizada fora de prazo (150). */
export const AUTORIZADA = new Set(['100', '150'])
/** Uso denegado: a nota existe, com o número consumido, mas não vale. */
export const DENEGADA = new Set(['110', '301', '302', '303'])

export type ResultadoAutorizacao =
  | { kind: 'autorizada'; chave: string; protocolo: string; recebidaEm: string; xmlProc: string; cStat: string; motivo: string }
  | { kind: 'denegada'; chave: string; protocolo: string; xmlProc: string; cStat: string; motivo: string }
  | { kind: 'rejeitada'; cStat: string; motivo: string }
  | { kind: 'em_processamento'; recibo: string }
  | { kind: 'indisponivel'; motivo: string }

export type ResultadoEvento =
  | { kind: 'registrado'; protocolo: string; cStat: string; motivo: string; xmlProc: string }
  | { kind: 'rejeitado'; cStat: string; motivo: string }
  | { kind: 'indisponivel'; motivo: string }

export type ResultadoInutilizacao =
  | { kind: 'homologada'; protocolo: string; xmlProc: string }
  | { kind: 'rejeitada'; cStat: string; motivo: string }
  | { kind: 'indisponivel'; motivo: string }

export type ResultadoStatus = { kind: 'ok' | 'fora'; cStat: string; motivo: string } | { kind: 'indisponivel'; motivo: string }

/** `<nfeProc>`: a NF-e assinada mais o `<protNFe>` devolvido, como manda o leiaute para guardar e entregar. */
export const nfeProc = (nfeAssinada: string, protNFe: string) =>
  `<nfeProc xmlns="${NS_NFE}" versao="${VERSAO_NFE}">${nfeAssinada}${protNFe}</nfeProc>`

function lerProtocolo(xml: string, doc: Document, nfeAssinada: string): ResultadoAutorizacao | null {
  const prot = first(doc, 'protNFe')
  if (!prot) return null
  const infProt = first(prot, 'infProt')
  const cStat = text(infProt, 'cStat')
  const motivo = text(infProt, 'xMotivo')
  const chave = text(infProt, 'chNFe')
  const protocolo = text(infProt, 'nProt')
  const protXml = trecho(xml, 'protNFe') ?? ''
  if (AUTORIZADA.has(cStat)) {
    return { kind: 'autorizada', chave, protocolo, recebidaEm: text(infProt, 'dhRecbto'), xmlProc: nfeProc(nfeAssinada, protXml), cStat, motivo }
  }
  if (DENEGADA.has(cStat)) return { kind: 'denegada', chave, protocolo, xmlProc: nfeProc(nfeAssinada, protXml), cStat, motivo }
  return { kind: 'rejeitada', cStat, motivo }
}

// --- cliente ---------------------------------------------------------------------------------------------------

export type SefazOptions = { transport?: SefinTransport; agora?: () => Date }

export type Credencial = { pem: PemCredentials }

/**
 * CNPJ do titular de um e-CNPJ da ICP-Brasil: o OtherName 2.16.76.1.3.3 do SubjectAltName ou, na falta dele, o fim
 * do CN ("RAZAO SOCIAL:12345678000195").
 */
export function cnpjDoCertificado(certPem: string): string | null {
  const cert = forge.pki.certificateFromPem(certPem)
  const san = cert.getExtension('subjectAltName') as { value?: string } | null
  if (san?.value) {
    try {
      const asn = forge.asn1.fromDer(san.value)
      for (const nome of (asn.value as forge.asn1.Asn1[]) ?? []) {
        if (nome.tagClass !== forge.asn1.Class.CONTEXT_SPECIFIC || nome.type !== 0) continue
        const partes = nome.value as forge.asn1.Asn1[]
        const oid = forge.asn1.derToOid(partes[0].value as string)
        if (oid !== '2.16.76.1.3.3') continue
        const bruto = forge.asn1.toDer(partes[1]).getBytes()
        const digitos = bruto.replace(/\D/g, '')
        if (digitos.length >= 14) return digitos.slice(-14)
      }
    } catch {
      // SAN fora do padrão: tenta o CN.
    }
  }
  const cn = cert.subject.getField('CN')?.value as string | undefined
  return /:(\d{14})$/.exec(cn ?? '')?.[1] ?? null
}

/**
 * Abre o A1 e confere que ele é do emitente: a Sefaz exige a mesma raiz de CNPJ (8 primeiros dígitos) entre o
 * certificado e o emitente (rejeição 213). Barrar aqui garante que nenhuma nota sai assinada por outro CNPJ (o do
 * escritório ou o da nó).
 */
export function abrirCertificado(certificado: Certificado, cnpjEmitente: string): Credencial | { erro: string } {
  let pem: PemCredentials
  try {
    pem = pfxToPem(certificado)
  } catch (error) {
    return { erro: error instanceof CertificateError ? `CERT_INVALID: ${error.message}` : 'CERT_INVALID' }
  }
  const doCert = cnpjDoCertificado(pem.certPem)
  const emitente = cnpjEmitente.replace(/\D/g, '')
  if (!doCert) return { erro: 'CERT_SEM_CNPJ: o certificado não traz CNPJ (precisa ser e-CNPJ A1 do emitente)' }
  if (doCert.slice(0, 8) !== emitente.slice(0, 8)) {
    return { erro: 'CERT_DE_OUTRO_CNPJ: o certificado não é do emitente; a NF-e só pode ser assinada pelo A1 da própria empresa' }
  }
  return { pem }
}

export function criarSefazClient(options: SefazOptions = {}) {
  const transport = options.transport ?? sefazTransport()

  async function chamar(
    uf: Uf,
    ambiente: AmbienteNfe,
    servico: ServicoNfe,
    corpo: string,
    cred: Credencial,
  ): Promise<{ xml: string; doc: Document } | { erro: string }> {
    const d = destino(uf, ambiente, servico)
    let res: HttpResponse
    try {
      res = await transport(
        {
          method: 'POST',
          url: d.url,
          headers: { 'content-type': `application/soap+xml; charset=utf-8; action="${WSDL}/${d.operacao}/${d.metodo}"` },
          body: envelope(d.operacao, corpo),
        },
        { key: cred.pem.keyPem, cert: [cred.pem.certPem, ...cred.pem.chainPem].join('\n') },
      )
    } catch (error) {
      return { erro: `${d.autorizador} ${servico}: ${error instanceof Error ? error.message : 'falha de transporte'}` }
    }
    const doc = parse(res.body)
    if (res.status >= 500 && !(doc && first(doc, 'cStat'))) return { erro: `${d.autorizador} ${servico}: HTTP ${res.status}` }
    if (!doc) return { erro: `${d.autorizador} ${servico}: resposta não é XML (HTTP ${res.status})` }
    if (!first(doc, 'cStat')) return { erro: `${d.autorizador} ${servico}: resposta sem cStat (HTTP ${res.status})` }
    return { xml: res.body, doc }
  }

  return {
    assinarNfe: (xml: string, cred: Credencial) =>
      signXml({ xml, signedElement: 'infNFe', keyPem: cred.pem.keyPem, certPem: cred.pem.certPem, profile: 'sha1-c14n' }),

    async status(uf: Uf, ambiente: AmbienteNfe, cred: Credencial): Promise<ResultadoStatus> {
      const r = await chamar(uf, ambiente, 'status', consultaStatus(ambiente, uf), cred)
      if ('erro' in r) return { kind: 'indisponivel', motivo: r.erro }
      const cStat = text(r.doc, 'cStat')
      return { kind: cStat === '107' ? 'ok' : 'fora', cStat, motivo: text(r.doc, 'xMotivo') }
    },

    /** Transmite uma NF-e já assinada. Lote síncrono; se a UF responder 103, devolve o recibo para consultar. */
    async autorizar(uf: Uf, ambiente: AmbienteNfe, nfeAssinada: string, cred: Credencial, idLote = novoIdLote()): Promise<ResultadoAutorizacao> {
      const r = await chamar(uf, ambiente, 'autorizacao', loteAutorizacao(nfeAssinada, idLote), cred)
      if ('erro' in r) return { kind: 'indisponivel', motivo: r.erro }
      const cStatLote = text(first(r.doc, 'retEnviNFe') ?? r.doc, 'cStat')
      const prot = lerProtocolo(r.xml, r.doc, nfeAssinada)
      if (prot) return prot
      if (cStatLote === '103') return { kind: 'em_processamento', recibo: text(r.doc, 'nRec') }
      return { kind: 'rejeitada', cStat: cStatLote, motivo: text(r.doc, 'xMotivo') }
    },

    async consultarRecibo(uf: Uf, ambiente: AmbienteNfe, recibo: string, nfeAssinada: string, cred: Credencial): Promise<ResultadoAutorizacao> {
      const r = await chamar(uf, ambiente, 'retAutorizacao', consultaRecibo(ambiente, recibo), cred)
      if ('erro' in r) return { kind: 'indisponivel', motivo: r.erro }
      const prot = lerProtocolo(r.xml, r.doc, nfeAssinada)
      if (prot) return prot
      const cStat = text(r.doc, 'cStat')
      if (cStat === '105') return { kind: 'em_processamento', recibo }
      return { kind: 'rejeitada', cStat, motivo: text(r.doc, 'xMotivo') }
    },

    /**
     * Consulta pela chave: depois de timeout ou de "duplicidade" (204/539), descobre se a nota foi autorizada antes
     * de reenviar ou de liberar o número.
     */
    async consultarChave(uf: Uf, ambiente: AmbienteNfe, chave: string, nfeAssinada: string, cred: Credencial): Promise<ResultadoAutorizacao | { kind: 'nao_encontrada' }> {
      const r = await chamar(uf, ambiente, 'consultaProtocolo', consultaChave(ambiente, chave), cred)
      if ('erro' in r) return { kind: 'indisponivel', motivo: r.erro }
      const prot = lerProtocolo(r.xml, r.doc, nfeAssinada)
      if (prot) return prot
      const cStat = text(first(r.doc, 'retConsSitNFe') ?? r.doc, 'cStat')
      if (cStat === '217') return { kind: 'nao_encontrada' }
      return { kind: 'rejeitada', cStat, motivo: text(r.doc, 'xMotivo') }
    },

    async evento(uf: Uf, ambiente: AmbienteNfe, pedido: PedidoEvento, cred: Credencial): Promise<ResultadoEvento> {
      const assinado = signXml({ xml: pedido.xml, signedElement: 'infEvento', keyPem: cred.pem.keyPem, certPem: cred.pem.certPem, profile: 'sha1-c14n' })
      const r = await chamar(uf, ambiente, 'evento', loteEvento(assinado, novoIdLote()), cred)
      if ('erro' in r) return { kind: 'indisponivel', motivo: r.erro }
      const ret = first(r.doc, 'retEvento')
      const inf = ret ? first(ret, 'infEvento') : null
      if (!inf) return { kind: 'rejeitado', cStat: text(r.doc, 'cStat'), motivo: text(r.doc, 'xMotivo') }
      const cStat = text(inf, 'cStat')
      const motivo = text(inf, 'xMotivo')
      // 135 registrado e vinculado; 136 registrado sem vínculo; 155 cancelamento fora de prazo homologado.
      if (cStat === '135' || cStat === '136' || cStat === '155') {
        const retXml = trecho(r.xml, 'retEvento') ?? ''
        return {
          kind: 'registrado',
          protocolo: text(inf, 'nProt'),
          cStat,
          motivo,
          xmlProc: `<procEventoNFe xmlns="${NS_NFE}" versao="1.00">${assinado}${retXml}</procEventoNFe>`,
        }
      }
      return { kind: 'rejeitado', cStat, motivo }
    },

    async inutilizar(uf: Uf, ambiente: AmbienteNfe, pedido: PedidoInutilizacao, cred: Credencial): Promise<ResultadoInutilizacao> {
      const assinado = signXml({ xml: pedido.xml, signedElement: 'infInut', keyPem: cred.pem.keyPem, certPem: cred.pem.certPem, profile: 'sha1-c14n' })
      const r = await chamar(uf, ambiente, 'inutilizacao', assinado, cred)
      if ('erro' in r) return { kind: 'indisponivel', motivo: r.erro }
      const cStat = text(r.doc, 'cStat')
      if (cStat === '102') {
        const ret = trecho(r.xml, 'retInutNFe') ?? ''
        return { kind: 'homologada', protocolo: text(r.doc, 'nProt'), xmlProc: `<procInutNFe xmlns="${NS_NFE}" versao="${VERSAO_NFE}">${assinado}${ret}</procInutNFe>` }
      }
      return { kind: 'rejeitada', cStat, motivo: text(r.doc, 'xMotivo') }
    },
  }
}

export type SefazClient = ReturnType<typeof criarSefazClient>
