// Distribuição de documentos do Ambiente de Dados Nacional (ADN) para o contribuinte (critério 19;
// Landing de .checks/agente-fiscal-v2.md, lote D - ADN). Fonte oficial: "Manual dos Contribuintes -
// Guia para utilização das API's do ADN", v1.0 de 12/02/2026 (gov.br/nfse): `GET /DFe/{NSU}` na
// API "ADN Contribuintes" (`https://adn[.producaorestrita].nfse.gov.br/contribuintes`), com o
// certificado do contribuinte na conexão. O parâmetro `lote=true`, os nomes dos campos do JSON e
// o 404 sem documentos NÃO estão no manual (a Swagger exige certificado): vêm das bibliotecas
// nfelib e t3wv/nfse. Qualquer resposta fora desse formato vira `indisponivel`, e a página oferece
// os PDFs. Nada daqui vai a log: o certificado e os XML ficam nesta chamada.
import { CertificateError, pfxToPem } from './pfx.js'
import { gunzipBase64, httpsTransport, TransportError, type SefinTransport } from './sefin-client.js'
import type { Ambiente, Certificado } from './sefin.js'
import { NfseXmlError, parseNfseXml, type NfseData } from './nfse-xml.js'

export const ADN_CONTRIBUINTES_URLS: Readonly<Record<Ambiente, string>> = {
  producao_restrita: 'https://adn.producaorestrita.nfse.gov.br/contribuintes',
  producao: 'https://adn.nfse.gov.br/contribuintes',
}

export const ADN_MAX_PAGINAS = 20
export const ADN_TIMEOUT_MS = 20_000

export type BaixaAdn = { kind: 'ok'; xmls: string[] } | { kind: 'indisponivel'; motivo: string }

export interface DistribuicaoAdn {
  /** XML das NFS-e em que o tenant é o emitente (o filtro é de quem chama: `nfseDoEmitente`). */
  baixarNfse(input: { cnpj: string; ambiente: Ambiente; certificado: Certificado }): Promise<BaixaAdn>
}

type Json = Record<string, unknown>

function pick(obj: unknown, name: string): unknown {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return undefined
  const key = Object.keys(obj).find((k) => k.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : (obj as Json)[key]
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

const nsuDe = (doc: unknown): number | null => {
  const bruto = pick(doc, 'NSU')
  const n = typeof bruto === 'number' ? bruto : typeof bruto === 'string' && /^\d+$/.test(bruto) ? Number(bruto) : NaN
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

export function createAdnClient(options: { transport?: SefinTransport; maxPaginas?: number } = {}): DistribuicaoAdn {
  const transport = options.transport ?? httpsTransport({ timeoutMs: ADN_TIMEOUT_MS })
  const maxPaginas = options.maxPaginas ?? ADN_MAX_PAGINAS

  return {
    async baixarNfse({ ambiente, certificado }) {
      let tls: { key: string; cert: string }
      try {
        const pem = pfxToPem(certificado)
        tls = { key: pem.keyPem, cert: [pem.certPem, ...pem.chainPem].join('\n') }
      } catch (error) {
        return { kind: 'indisponivel', motivo: error instanceof CertificateError ? 'CERT_INVALID' : 'CERT_ERROR' }
      }

      const xmls: string[] = []
      const vistos = new Set<string>()
      let nsu = 0
      for (let pagina = 0; pagina < maxPaginas; pagina++) {
        let resposta: { status: number; body: string }
        try {
          resposta = await transport(
            {
              method: 'GET',
              url: `${ADN_CONTRIBUINTES_URLS[ambiente]}/DFe/${nsu}?lote=true`,
              headers: { accept: 'application/json' },
            },
            tls,
          )
        } catch (error) {
          return { kind: 'indisponivel', motivo: error instanceof TransportError ? 'TRANSPORTE' : 'TRANSPORTE_DESCONHECIDO' }
        }
        if (resposta.status === 404) break
        if (resposta.status !== 200) return { kind: 'indisponivel', motivo: `HTTP_${resposta.status}` }
        const corpo = parseJson(resposta.body)
        const lote = pick(corpo, 'LoteDFe')
        if (corpo === undefined || (lote !== undefined && lote !== null && !Array.isArray(lote))) {
          return { kind: 'indisponivel', motivo: 'FORMATO' }
        }
        const documentos = Array.isArray(lote) ? lote : []
        if (documentos.length === 0) break

        let maior = nsu
        for (const doc of documentos) {
          const n = nsuDe(doc)
          if (n === null) return { kind: 'indisponivel', motivo: 'FORMATO' }
          maior = Math.max(maior, n)
          if (String(pick(doc, 'TipoDocumento') ?? '').toUpperCase() !== 'NFSE') continue
          const arquivo = pick(doc, 'ArquivoXml')
          if (typeof arquivo !== 'string' || !arquivo) return { kind: 'indisponivel', motivo: 'FORMATO' }
          const chave = String(pick(doc, 'ChaveAcesso') ?? `nsu:${n}`)
          if (vistos.has(chave)) continue
          vistos.add(chave)
          try {
            xmls.push(gunzipBase64(arquivo))
          } catch {
            return { kind: 'indisponivel', motivo: 'FORMATO' }
          }
        }
        if (maior <= nsu) break
        nsu = maior
      }
      return { kind: 'ok', xmls }
    },
  }
}

/** NFS-e legíveis em que o tenant é o emitente e o tomador tem CPF ou CNPJ. */
export function nfseDoEmitente(xmls: string[], cnpj: string): NfseData[] {
  const notas: NfseData[] = []
  for (const xml of xmls) {
    let nota: NfseData
    try {
      nota = parseNfseXml(xml)
    } catch (error) {
      if (error instanceof NfseXmlError) continue
      throw error
    }
    const emitente = nota.emitente.CNPJ ?? nota.dps.prestador.CNPJ
    if (emitente !== cnpj) continue
    if (!nota.dps.tomador?.CNPJ && !nota.dps.tomador?.CPF) continue
    notas.push(nota)
  }
  return notas
}
