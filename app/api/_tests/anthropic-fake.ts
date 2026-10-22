// Dublê da API da Anthropic para os testes do lote D: um servidor HTTP local, alcançado pelo SDK
// oficial via `ANTHROPIC_BASE_URL` (ou `baseURL`). Guarda cada requisição e responde no formato do
// `POST /v1/messages`. Nenhum teste chama a API de verdade.
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export type ChamadaIa = {
  path: string
  apiKey: string | undefined
  corpo: {
    model: string
    max_tokens: number
    system?: unknown
    messages: { role: string; content: unknown }[]
    output_config?: { format?: { type: string; schema: Record<string, unknown> } }
  }
}

export type RespostaIa =
  | { json: unknown; tokens?: { entrada: number; saida: number }; stopReason?: string }
  | { status: number; erro: string }

export type DubleIa = {
  url: string
  chamadas: ChamadaIa[]
  responder: (chamada: ChamadaIa) => RespostaIa
  fechar(): Promise<void>
}

const lerCorpo = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    const partes: Buffer[] = []
    req.on('data', (parte: Buffer) => partes.push(parte))
    req.on('end', () => resolve(Buffer.concat(partes).toString('utf8')))
    req.on('error', reject)
  })

export async function iniciarDubleIa(responder: DubleIa['responder']): Promise<DubleIa> {
  const duble: DubleIa = { url: '', chamadas: [], responder, fechar: async () => undefined }
  const server: Server = createServer(async (req, res) => {
    const corpo = JSON.parse(await lerCorpo(req)) as ChamadaIa['corpo']
    // O SDK 1.x manda a chave em `authorization: Bearer`; versões antigas, em `x-api-key`.
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1]
    const chamada: ChamadaIa = { path: req.url ?? '', apiKey: (req.headers['x-api-key'] as string | undefined) ?? bearer, corpo }
    duble.chamadas.push(chamada)
    const resposta = duble.responder(chamada)
    if ('erro' in resposta) {
      res
        .writeHead(resposta.status, { 'content-type': 'application/json' })
        .end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: resposta.erro } }))
      return
    }
    const tokens = resposta.tokens ?? { entrada: 100, saida: 20 }
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        id: `msg_teste_${duble.chamadas.length}`,
        type: 'message',
        role: 'assistant',
        model: corpo.model,
        content: [{ type: 'text', text: JSON.stringify(resposta.json) }],
        stop_reason: resposta.stopReason ?? 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: tokens.entrada,
          output_tokens: tokens.saida,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  duble.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  duble.fechar = () => new Promise<void>((resolve) => server.close(() => resolve()))
  return duble
}

/** Texto do primeiro bloco de texto (ou a string) da mensagem do usuário. */
export function textoDoUsuario(chamada: ChamadaIa): string {
  const content = chamada.corpo.messages[0]?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const bloco = content.find((b) => (b as { type?: string }).type === 'text') as { text?: string } | undefined
    return bloco?.text ?? ''
  }
  return ''
}

/** Bytes do PDF enviado no bloco `document`, ou `null`. */
export function pdfDaChamada(chamada: ChamadaIa): Buffer | null {
  const content = chamada.corpo.messages[0]?.content
  if (!Array.isArray(content)) return null
  const doc = content.find((b) => (b as { type?: string }).type === 'document') as
    | { source?: { type?: string; media_type?: string; data?: string } }
    | undefined
  if (doc?.source?.type !== 'base64' || doc.source.media_type !== 'application/pdf' || !doc.source.data) return null
  return Buffer.from(doc.source.data, 'base64')
}
