// Dublê de transporte da Sefin Nacional para os testes: recebe as requisições que o cliente
// real (`sefin-client.ts`) monta, descomprime o XML e responde no formato do OpenAPI capturado
// pela open-nfse (referência §3). Nenhum teste chama a Sefin.
import { randomInt } from 'node:crypto'
import { gunzipBase64, gzipBase64, type HttpRequest, type HttpResponse, type SefinTransport, type TlsCredentials } from '../_lib/sefin-client.js'

export const NFSE_NS = 'http://www.sped.fazenda.gov.br/nfse'

export type FakeRequest = HttpRequest & {
  path: string
  /** XML descomprimido do corpo (DPS ou pedido de evento), quando houver. */
  xml: string | null
  tls: TlsCredentials
}

export type FakeScript = {
  /** Resposta do `POST /nfse`; `undefined` = autoriza. */
  emitir?: (dpsXml: string) => HttpResponse | undefined | Promise<HttpResponse | undefined>
  /** Resposta do `POST /nfse/{chave}/eventos`; `undefined` = aceita. */
  evento?: (pedidoXml: string) => HttpResponse | undefined | Promise<HttpResponse | undefined>
  /** Falha de rede em qualquer chamada cujo caminho combine. */
  networkError?: RegExp
}

const tag = (xml: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1] ?? ''

export function chaveFor(dpsXml: string, nNFSe: number, ambGer = '2'): string {
  const cnpj = tag(dpsXml, 'CNPJ')
  const mun = tag(dpsXml, 'cLocEmi')
  const aamm = tag(dpsXml, 'dCompet').slice(2, 7).replace('-', '')
  const random = String(randomInt(0, 1_000_000_000)).padStart(9, '0')
  return `${mun}${ambGer}2${cnpj}${String(nNFSe).padStart(13, '0')}${aamm}${random}0`
}

/** NFS-e no formato do exemplo real da open-nfse (`specs/samples`), com a DPS assinada dentro. */
export function testNfseXml(input: { dpsXml: string; chave: string; nNFSe: number; dhProc?: string }): string {
  const dps = input.dpsXml.replace(/^<\?xml[^>]*\?>/, '')
  const valor = tag(dps, 'vServ')
  return (
    `<NFSe xmlns="${NFSE_NS}" versao="1.01"><infNFSe Id="NFS${input.chave}">` +
    `<xLocEmi>São Paulo</xLocEmi><xLocPrestacao>São Paulo</xLocPrestacao><nNFSe>${input.nNFSe}</nNFSe>` +
    `<cLocIncid>3550308</cLocIncid><xLocIncid>São Paulo</xLocIncid>` +
    `<xTribNac>Medicina.</xTribNac><verAplic>SefinNacional_1.6.0</verAplic><ambGer>2</ambGer><tpEmis>1</tpEmis>` +
    `<procEmi>1</procEmi><cStat>100</cStat><dhProc>${input.dhProc ?? '2026-11-03T10:15:00-03:00'}</dhProc><nDFSe>987654</nDFSe>` +
    `<emit><CNPJ>${tag(dps, 'CNPJ')}</CNPJ><xNome>PRIMECARE SERVICOS MEDICOS LTDA</xNome>` +
    `<enderNac><xLgr>AVENIDA PAULISTA</xLgr><nro>1000</nro><xBairro>BELA VISTA</xBairro><cMun>3550308</cMun><UF>SP</UF><CEP>01310100</CEP></enderNac>` +
    `<fone>11999990000</fone><email>financeiro@primecare.test</email></emit>` +
    `<valores><vLiq>${valor}</vLiq></valores>${dps}</infNFSe></NFSe>`
  )
}

const json = (status: number, body: unknown): HttpResponse => ({ status, body: JSON.stringify(body) })

export function fakeSefin(script: FakeScript = {}): {
  transport: SefinTransport
  requests: FakeRequest[]
  /** NFS-e geradas, por Id da DPS. */
  issued: Map<string, { chave: string; xml: string }>
  events: Map<string, string>
} {
  const requests: FakeRequest[] = []
  const issued = new Map<string, { chave: string; xml: string }>()
  const events = new Map<string, string>()
  let nextNumber = 1

  const transport: SefinTransport = async (request, tls) => {
    const path = new URL(request.url).pathname.replace(/^\/SefinNacional/, '')
    let xml: string | null = null
    if (request.body) {
      const body = JSON.parse(request.body) as Record<string, string>
      const b64 = body.dpsXmlGZipB64 ?? body.pedidoRegistroEventoXmlGZipB64
      if (b64) xml = gunzipBase64(b64)
    }
    requests.push({ ...request, path, xml, tls })
    if (script.networkError?.test(path)) throw new Error('ECONNRESET simulado')

    if (request.method === 'POST' && path === '/nfse' && xml) {
      const custom = await script.emitir?.(xml)
      if (custom) return custom
      const id = /Id="([^"]+)"/.exec(xml)?.[1] ?? ''
      const nNFSe = nextNumber++
      const chave = chaveFor(xml, nNFSe)
      const nfse = testNfseXml({ dpsXml: xml, chave, nNFSe })
      issued.set(id, { chave, xml: nfse })
      return json(201, {
        tipoAmbiente: 2,
        versaoAplicativo: 'SefinNac_Pre_1.6.0',
        dataHoraProcessamento: '2026-11-03T10:15:00-03:00',
        idDps: id,
        chaveAcesso: chave,
        nfseXmlGZipB64: gzipBase64(nfse),
        alertas: [],
      })
    }

    const dpsMatch = /^\/dps\/([^/]+)$/.exec(path)
    if (request.method === 'GET' && dpsMatch) {
      const found = issued.get(decodeURIComponent(dpsMatch[1]))
      return found ? json(200, { idDps: dpsMatch[1], chaveAcesso: found.chave }) : json(404, {})
    }

    const eventoMatch = /^\/nfse\/(\d{50})\/eventos$/.exec(path)
    if (request.method === 'POST' && eventoMatch && xml) {
      const custom = await script.evento?.(xml)
      if (custom) return custom
      const evento = `<evento xmlns="${NFSE_NS}" versao="1.01"><infEvento Id="EVT${eventoMatch[1]}101101001"><nSeqEvento>1</nSeqEvento>${xml}</infEvento></evento>`
      events.set(eventoMatch[1], evento)
      return json(201, { tipoAmbiente: 2, versaoAplicativo: 'SefinNac_Pre_1.6.0', eventoXmlGZipB64: gzipBase64(evento) })
    }

    const consultaEvento = /^\/nfse\/(\d{50})\/eventos\/101101\/1$/.exec(path)
    if (request.method === 'GET' && consultaEvento) {
      const evento = events.get(consultaEvento[1])
      return evento ? json(200, { eventoXmlGZipB64: gzipBase64(evento) }) : json(404, {})
    }

    const nfseMatch = /^\/nfse\/(\d{50})$/.exec(path)
    if (request.method === 'GET' && nfseMatch) {
      const found = [...issued.values()].find((n) => n.chave === nfseMatch[1])
      return found ? json(200, { chaveAcesso: found.chave, nfseXmlGZipB64: gzipBase64(found.xml) }) : json(404, {})
    }
    return json(404, { erros: [{ Codigo: 'ROTA', Descricao: `rota não simulada: ${request.method} ${path}` }] })
  }
  return { transport, requests, issued, events }
}
