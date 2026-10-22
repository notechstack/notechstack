// Cliente real da Sefin Nacional (Landing do checklist, lote 2b - cliente Sefin real):
// mTLS com o A1 convertido para PEM em memória, HTTP/1.1 por `node:https`, URL base escolhida
// pelo `ambiente` do tenant, XML assinado comprimido em gzip e base64. Nenhum log aqui: o motor
// decide o que registra, e o certificado nunca sai desta chamada (critério 22).
import https from 'node:https'
import { rootCertificates } from 'node:tls'
import { gunzipSync, gzipSync } from 'node:zlib'
import { buildDps, buildIdDps, DpsInvalidError } from './dps-builder.js'
import { buildPedidoCancelamento } from './evento-builder.js'
import { CertificateError, pfxToPem, type PemCredentials } from './pfx.js'
import type {
  Ambiente,
  CancelarResultado,
  Certificado,
  ConsultaCancelamentoResultado,
  ConsultaResultado,
  EmitirResultado,
  SefinClient,
  SefinTenant,
} from './sefin.js'
import { DEFAULT_SIGNATURE_PROFILE, signXml, type SignatureProfile } from './xml-signer.js'

export const SEFIN_BASE_URLS: Readonly<Record<Ambiente, string>> = {
  producao_restrita: 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional',
  producao: 'https://sefin.nfse.gov.br/SefinNacional',
}

export const SEFIN_TIMEOUT_MS = 30_000

export type HttpRequest = {
  method: 'GET' | 'POST' | 'HEAD'
  url: string
  headers: Record<string, string>
  body?: string
}
export type HttpResponse = { status: number; body: string }
/** Credenciais do mTLS: chave e certificado do A1 (a cadeia vem depois do certificado). */
export type TlsCredentials = { key: string; cert: string }
export type SefinTransport = (request: HttpRequest, tls: TlsCredentials) => Promise<HttpResponse>

export class TransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransportError'
  }
}

/**
 * Transporte padrão: `node:https`, que fala só HTTP/1.1 (a Sefin recusa HTTP/2). Um `Agent`
 * por chamada, sem keep-alive, para a chave do tenant não ficar presa num pool. O servidor é
 * verificado pela lista de CAs do Node, mais `extraCa` quando informado (spike, `--ca`).
 */
export function httpsTransport(options: { timeoutMs?: number; extraCa?: string[] } = {}): SefinTransport {
  const timeoutMs = options.timeoutMs ?? SEFIN_TIMEOUT_MS
  const ca = options.extraCa?.length ? [...rootCertificates, ...options.extraCa] : undefined
  return (request, tls) =>
    new Promise<HttpResponse>((resolve, reject) => {
      const agent = new https.Agent({ key: tls.key, cert: tls.cert, ca, keepAlive: false, maxCachedSessions: 0 })
      const headers = { ...request.headers }
      if (request.body !== undefined) headers['content-length'] = String(Buffer.byteLength(request.body, 'utf8'))
      const req = https.request(request.url, { method: request.method, headers, agent, timeout: timeoutMs }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          agent.destroy()
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        })
        res.on('error', (error) => {
          agent.destroy()
          reject(new TransportError(`resposta interrompida: ${error.message}`))
        })
      })
      req.on('timeout', () => req.destroy(new TransportError(`timeout de ${timeoutMs} ms`)))
      req.on('error', (error) => {
        agent.destroy()
        reject(error instanceof TransportError ? error : new TransportError(`${error.name}: ${error.message}`))
      })
      if (request.body !== undefined) req.write(request.body)
      req.end()
    })
}

export const gzipBase64 = (xml: string) => gzipSync(Buffer.from(xml, 'utf8')).toString('base64')
export const gunzipBase64 = (b64: string) => gunzipSync(Buffer.from(b64, 'base64')).toString('utf8')

type Json = Record<string, unknown>
type Mensagem = { codigo: string; descricao: string }

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** Campo do JSON sem diferenciar maiúsculas (a Sefin manda `Codigo` e `codigo`). */
function pick(obj: unknown, name: string): unknown {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return undefined
  const key = Object.keys(obj).find((k) => k.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : (obj as Json)[key]
}

const str = (value: unknown) => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '')

/** Mensagens de `erros`/`erro`, em array ou objeto (no evento, `erro` chega como array). */
function mensagens(body: unknown): Mensagem[] {
  const raw = pick(body, 'erros') ?? pick(body, 'erro')
  const items: unknown[] = Array.isArray(raw) ? raw : raw ? [raw] : []
  return items
    .map((item) => {
      const complemento = str(pick(item, 'complemento'))
      const descricao = str(pick(item, 'descricao'))
      return { codigo: str(pick(item, 'codigo')), descricao: complemento ? `${descricao} (${complemento})` : descricao }
    })
    .filter((m) => m.codigo || m.descricao)
}

/** Procura em qualquer nível o campo pedido (o formato do 200 da consulta de evento é incerto). */
function findDeep(value: unknown, field: string): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDeep(item, field)
      if (found) return found
    }
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const direct = pick(value, field)
  if (typeof direct === 'string' && direct) return direct
  for (const child of Object.values(value)) {
    const found = findDeep(child, field)
    if (found) return found
  }
  return null
}

const describe = (list: Mensagem[]) => list.map((m) => `${m.codigo}: ${m.descricao}`.trim()).join(' | ')

/** E999 (não catalogado, quase sempre instabilidade) e certificado de transmissão (E1200–E1209). */
export function isTransientCode(code: string): boolean {
  return code === 'E999' || /^E120\d$/.test(code)
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', accept: 'application/json' }

export type SefinClientOptions = {
  transport?: SefinTransport
  perfilAssinatura?: SignatureProfile
  now?: () => Date
}

export function createSefinClient(options: SefinClientOptions = {}): SefinClient {
  const transport = options.transport ?? httpsTransport()
  const profile = options.perfilAssinatura ?? DEFAULT_SIGNATURE_PROFILE
  const now = options.now ?? (() => new Date())

  const tlsOf = (pem: PemCredentials): TlsCredentials => ({ key: pem.keyPem, cert: [pem.certPem, ...pem.chainPem].join('\n') })
  const url = (tenant: SefinTenant, path: string) => `${SEFIN_BASE_URLS[tenant.ambiente]}${path}`

  async function send(request: HttpRequest, pem: PemCredentials): Promise<HttpResponse | { error: string }> {
    try {
      return await transport(request, tlsOf(pem))
    } catch (error) {
      return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
    }
  }

  function openCertificate(certificado: Certificado): PemCredentials | { error: string } {
    try {
      return pfxToPem(certificado)
    } catch (error) {
      return { error: error instanceof CertificateError ? `CERT_INVALID: ${error.message}` : 'CERT_INVALID' }
    }
  }

  async function consultar(tenant: SefinTenant, idDps: string, pem: PemCredentials): Promise<ConsultaResultado> {
    const dps = await send({ method: 'GET', url: url(tenant, `/dps/${encodeURIComponent(idDps)}`), headers: JSON_HEADERS }, pem)
    if ('error' in dps) return { kind: 'unavailable', reason: dps.error }
    if (dps.status === 404) return { kind: 'not_found' }
    if (dps.status !== 200) return { kind: 'unavailable', reason: `GET /dps respondeu HTTP ${dps.status}` }
    const chaveAcesso = str(pick(parseJson(dps.body), 'chaveAcesso'))
    if (!chaveAcesso) return { kind: 'unavailable', reason: 'GET /dps sem chaveAcesso' }

    const nfse = await send({ method: 'GET', url: url(tenant, `/nfse/${encodeURIComponent(chaveAcesso)}`), headers: JSON_HEADERS }, pem)
    if ('error' in nfse) return { kind: 'unavailable', reason: nfse.error }
    if (nfse.status !== 200) return { kind: 'unavailable', reason: `GET /nfse respondeu HTTP ${nfse.status}` }
    const b64 = str(pick(parseJson(nfse.body), 'nfseXmlGZipB64'))
    if (!b64) return { kind: 'unavailable', reason: 'GET /nfse sem nfseXmlGZipB64' }
    try {
      return { kind: 'found', chaveAcesso, xmlNfse: gunzipBase64(b64) }
    } catch {
      return { kind: 'unavailable', reason: 'nfseXmlGZipB64 ilegível' }
    }
  }

  return {
    idDps: ({ tenant, serie, numero }) => buildIdDps(tenant, serie, numero),

    async emitir({ tenant, invoice, certificado }): Promise<EmitirResultado> {
      let dps: { id: string; xml: string }
      try {
        dps = buildDps({ tenant, serie: invoice.dps_serie, numero: invoice.dps_numero, payload: invoice.payload, now: now() })
      } catch (error) {
        if (error instanceof DpsInvalidError) return { kind: 'rejected', code: error.code, message: error.message }
        throw error
      }
      if (dps.id !== invoice.id_dps) {
        return { kind: 'rejected', code: 'DPS_INVALID', message: 'Id da DPS diverge do gravado na nota' }
      }
      const pem = openCertificate(certificado)
      if ('error' in pem) return { kind: 'unavailable', reason: pem.error }
      const xmlDps = signXml({ xml: dps.xml, signedElement: 'infDPS', keyPem: pem.keyPem, certPem: pem.certPem, profile })

      const response = await send(
        {
          method: 'POST',
          url: url(tenant, '/nfse'),
          headers: JSON_HEADERS,
          body: JSON.stringify({ dpsXmlGZipB64: gzipBase64(xmlDps) }),
        },
        pem,
      )
      if ('error' in response) return { kind: 'unavailable', reason: response.error }
      const body = parseJson(response.body)

      if (response.status >= 200 && response.status < 300) {
        const chaveAcesso = str(pick(body, 'chaveAcesso'))
        const b64 = str(pick(body, 'nfseXmlGZipB64'))
        if (!chaveAcesso || !b64) return { kind: 'unavailable', reason: `HTTP ${response.status} sem chaveAcesso ou nfseXmlGZipB64` }
        try {
          return { kind: 'authorized', chaveAcesso, xmlDps, xmlNfse: gunzipBase64(b64) }
        } catch {
          return { kind: 'unavailable', reason: 'nfseXmlGZipB64 ilegível' }
        }
      }
      if (response.status >= 500) return { kind: 'unavailable', reason: `HTTP ${response.status}: ${describe(mensagens(body))}` }

      const erros = mensagens(body)
      if (erros.some((m) => m.codigo === 'E0014')) {
        // Esta DPS já gerou NFS-e (envio anterior cuja resposta se perdeu): busca a nota.
        const consulta = await consultar(tenant, dps.id, pem)
        if (consulta.kind === 'found') {
          return { kind: 'authorized', chaveAcesso: consulta.chaveAcesso, xmlDps, xmlNfse: consulta.xmlNfse }
        }
        return { kind: 'unavailable', reason: `E0014 e a consulta não achou a NFS-e (${consulta.kind})` }
      }
      if (erros.length === 0) return { kind: 'unavailable', reason: `HTTP ${response.status} sem mensagens de erro` }
      if (isTransientCode(erros[0].codigo)) return { kind: 'unavailable', reason: describe(erros) }
      return { kind: 'rejected', code: erros[0].codigo || `HTTP_${response.status}`, message: describe(erros) }
    },

    async consultarPorIdDps({ tenant, idDps, certificado }): Promise<ConsultaResultado> {
      const pem = openCertificate(certificado)
      if ('error' in pem) return { kind: 'unavailable', reason: pem.error }
      return consultar(tenant, idDps, pem)
    },

    async cancelar({ tenant, chaveAcesso, certificado }): Promise<CancelarResultado> {
      const pem = openCertificate(certificado)
      if ('error' in pem) return { kind: 'unavailable', reason: pem.error }
      const pedido = buildPedidoCancelamento({ tenant, chaveAcesso, now: now() })
      const xml = signXml({ xml: pedido.xml, signedElement: 'infPedReg', keyPem: pem.keyPem, certPem: pem.certPem, profile })
      const response = await send(
        {
          method: 'POST',
          url: url(tenant, `/nfse/${encodeURIComponent(chaveAcesso)}/eventos`),
          headers: JSON_HEADERS,
          body: JSON.stringify({ pedidoRegistroEventoXmlGZipB64: gzipBase64(xml) }),
        },
        pem,
      )
      if ('error' in response) return { kind: 'unavailable', reason: response.error }
      const body = parseJson(response.body)
      if (response.status >= 200 && response.status < 300) {
        const b64 = str(pick(body, 'eventoXmlGZipB64'))
        if (!b64) return { kind: 'unavailable', reason: `HTTP ${response.status} sem eventoXmlGZipB64` }
        try {
          return { kind: 'accepted', xml: gunzipBase64(b64) }
        } catch {
          return { kind: 'unavailable', reason: 'eventoXmlGZipB64 ilegível' }
        }
      }
      if (response.status >= 500) return { kind: 'unavailable', reason: `HTTP ${response.status}: ${describe(mensagens(body))}` }
      const erros = mensagens(body)
      if (erros.length > 0 && isTransientCode(erros[0].codigo)) return { kind: 'unavailable', reason: describe(erros) }
      return {
        kind: 'refused',
        code: erros[0]?.codigo || `HTTP_${response.status}`,
        message: erros.length ? describe(erros) : `HTTP ${response.status} sem mensagens de erro`,
      }
    },

    async consultarCancelamento({ tenant, chaveAcesso, certificado }): Promise<ConsultaCancelamentoResultado> {
      const pem = openCertificate(certificado)
      if ('error' in pem) return { kind: 'unavailable', reason: pem.error }
      const response = await send(
        { method: 'GET', url: url(tenant, `/nfse/${encodeURIComponent(chaveAcesso)}/eventos/101101/1`), headers: JSON_HEADERS },
        pem,
      )
      if ('error' in response) return { kind: 'unavailable', reason: response.error }
      if (response.status === 404) return { kind: 'not_found' }
      if (response.status !== 200) return { kind: 'unavailable', reason: `GET /eventos respondeu HTTP ${response.status}` }
      const b64 = findDeep(parseJson(response.body), 'eventoXmlGZipB64')
      if (!b64) return { kind: 'unavailable', reason: 'GET /eventos sem eventoXmlGZipB64' }
      try {
        return { kind: 'found', xml: gunzipBase64(b64) }
      } catch {
        return { kind: 'unavailable', reason: 'eventoXmlGZipB64 ilegível' }
      }
    },
  }
}

/** Cliente usado pelo worker na Vercel: transporte HTTPS padrão e perfil de assinatura padrão. */
export function sefinClientFromEnv(): SefinClient {
  return createSefinClient()
}
