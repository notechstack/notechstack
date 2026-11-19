// Dublê de transporte da Sefin Nacional para os testes: recebe as requisições que o cliente
// real (`sefin-client.ts`) monta, descomprime o XML e responde no formato do OpenAPI capturado
// pela open-nfse (referência §3). Nenhum teste chama a Sefin.
import { chaveSimulada as chaveFor, eventoCancelamentoSimulado, nfseSimulada as testNfseXml } from '../_lib/sandbox/sefin-simulada.js'
import { gunzipBase64, gzipBase64, type HttpRequest, type HttpResponse, type SefinTransport, type TlsCredentials } from '../_lib/sefin-client.js'

// Os geradores de chave e de NFS-e moraram aqui até virarem o simulador do sandbox (`_lib/sandbox/sefin-simulada.ts`).
export { NFSE_NS, chaveSimulada as chaveFor, nfseSimulada as testNfseXml } from '../_lib/sandbox/sefin-simulada.js'

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
      const evento = eventoCancelamentoSimulado(eventoMatch[1], xml)
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
