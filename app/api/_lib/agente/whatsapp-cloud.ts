// Cliente real da WhatsApp Cloud API (Meta), atrás de `EnviaWhatsApp`. Nenhum teste o chama
// fora da Meta: os testes passam um `fetch` de dublê. Fonte: developers.facebook.com,
// "Cloud API – Messages", "Media" e "Send message templates": `POST /{versão}/{Phone-Number-ID}/messages`
// (texto, documento ou `type:'template'` com `template:{name, language:{code}, components}`),
// `POST /{versão}/{Phone-Number-ID}/media` (multipart `messaging_product`, `type`, `file` → `id`) e,
// para baixar o que chega (planilha do lote, conta Escritório), `GET /{versão}/{media-id}` (→ `url`,
// `mime_type`, `file_size`) seguido de `GET <url>`, os dois com `Authorization: Bearer <token>`. Versão v26.0 (changelog da Graph API, 29/07/2026).
// A base vem de `WHATSAPP_GRAPH_URL` (padrão oficial; Landing v2, lote C), para a demonstração.
// O token e o corpo das respostas nunca vão para o log.
import type { AnexoEmail, Enviada, EnviaWhatsApp } from './canais.js'

export const GRAPH_API = 'https://graph.facebook.com'
export const GRAPH_VERSION = 'v26.0'
export const IDIOMA_DOS_MODELOS = 'pt_BR'
const TIMEOUT_MS = 10_000
/** Planilha do lote (Planilha v1 em .design/agente-fiscal-escritorio.md): até 5 MB. */
export const LIMITE_DA_MIDIA = 5 * 1024 * 1024

type FetchLike = typeof fetch

export class WhatsAppHttpError extends Error {
  /** `error.code` e o detalhe que a Meta devolve (sem o token): vão para a central de conversas, nunca para o log. */
  constructor(
    readonly status: number,
    readonly codigo: number | null = null,
    readonly detalhe: string | null = null,
  ) {
    super(`Cloud API respondeu ${status}`)
    this.name = 'WhatsAppHttpError'
  }
}

/** A mídia passou do limite: nada além do limite é lido. */
export class MidiaGrandeDemais extends Error {
  constructor(readonly limite: number) {
    super(`mídia acima de ${limite} bytes`)
    this.name = 'MidiaGrandeDemais'
  }
}

export type MidiaBaixada = { conteudo: Uint8Array; mime: string | null }

export interface BaixaMidia {
  /** Baixa a mídia recebida (`messages[].document.id`), até `limite` bytes (padrão 5 MB). */
  baixarMidia(mediaId: string, limite?: number): Promise<MidiaBaixada>
}

/** Lê o corpo até `limite` bytes; passou, cancela a leitura e lança `MidiaGrandeDemais`. */
async function corpoAte(res: Response, limite: number): Promise<Uint8Array> {
  const declarado = Number(res.headers.get('content-length'))
  if (Number.isFinite(declarado) && declarado > limite) {
    await res.body?.cancel().catch(() => undefined)
    throw new MidiaGrandeDemais(limite)
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer())
  const partes: Uint8Array[] = []
  let total = 0
  const leitor = res.body.getReader()
  for (;;) {
    const { done, value } = await leitor.read()
    if (done) break
    total += value.byteLength
    if (total > limite) {
      await leitor.cancel().catch(() => undefined)
      throw new MidiaGrandeDemais(limite)
    }
    partes.push(value)
  }
  const tudo = new Uint8Array(total)
  let posicao = 0
  for (const parte of partes) {
    tudo.set(parte, posicao)
    posicao += parte.byteLength
  }
  return tudo
}

async function erroDaResposta(res: Response): Promise<WhatsAppHttpError> {
  const corpo = (await res.json().catch(() => null)) as {
    error?: { code?: unknown; message?: unknown; error_data?: { details?: unknown } }
  } | null
  const erro = corpo?.error
  const detalhe = erro?.error_data?.details ?? erro?.message
  return new WhatsAppHttpError(res.status, typeof erro?.code === 'number' ? erro.code : null, typeof detalhe === 'string' ? detalhe.slice(0, 300) : null)
}

export function whatsappCloud(opcoes: {
  token: string
  phoneNumberId: string
  versao?: string
  graphUrl?: string
  fetch?: FetchLike
}): EnviaWhatsApp & BaixaMidia {
  const doFetch = opcoes.fetch ?? fetch
  const raiz = (opcoes.graphUrl || GRAPH_API).replace(/\/+$/, '')
  const versao = `${raiz}/${opcoes.versao ?? GRAPH_VERSION}`
  const base = `${versao}/${encodeURIComponent(opcoes.phoneNumberId)}`
  const autorizacao = { authorization: `Bearer ${opcoes.token}` }
  // A Cloud API endereça o número só com dígitos, como chega em `messages[].from`.
  const destino = (para: string) => para.replace(/\D/g, '')

  /** A resposta traz o `wamid` em `messages[0].id`: é por ele que as marcas de entregue e lida acham a mensagem. */
  async function mensagem(corpo: Record<string, unknown>): Promise<Enviada> {
    const res = await doFetch(`${base}/messages`, {
      method: 'POST',
      headers: { ...autorizacao, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...corpo }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) throw await erroDaResposta(res)
    const resposta = (await res.json().catch(() => null)) as { messages?: { id?: unknown }[] } | null
    const wamid = resposta?.messages?.[0]?.id
    return { wamid: typeof wamid === 'string' ? wamid : null }
  }

  async function subirMidia(anexo: AnexoEmail): Promise<string> {
    const form = new FormData()
    form.set('messaging_product', 'whatsapp')
    form.set('type', anexo.tipo)
    form.set('file', new Blob([Buffer.from(anexo.conteudo)], { type: anexo.tipo }), anexo.nome)
    const res = await doFetch(`${base}/media`, {
      method: 'POST',
      headers: autorizacao,
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) throw await erroDaResposta(res)
    const corpo = (await res.json().catch(() => null)) as { id?: unknown } | null
    if (typeof corpo?.id !== 'string') throw new WhatsAppHttpError(res.status)
    return corpo.id
  }

  /** O token só vai para a URL da mídia se ela for https (ou da mesma origem da Graph API configurada). */
  function urlDaMidia(url: unknown): string {
    if (typeof url !== 'string') throw new WhatsAppHttpError(502)
    const destino = new URL(url)
    if (destino.protocol !== 'https:' && destino.origin !== new URL(raiz).origin) throw new WhatsAppHttpError(502)
    return destino.toString()
  }

  return {
    async baixarMidia(mediaId, limite = LIMITE_DA_MIDIA) {
      const info = await doFetch(`${versao}/${encodeURIComponent(mediaId)}`, {
        headers: autorizacao,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!info.ok) throw await erroDaResposta(info)
      const corpo = (await info.json().catch(() => null)) as { url?: unknown; mime_type?: unknown; file_size?: unknown } | null
      if (typeof corpo?.file_size === 'number' && corpo.file_size > limite) throw new MidiaGrandeDemais(limite)
      const res = await doFetch(urlDaMidia(corpo?.url), { headers: autorizacao, signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!res.ok) throw await erroDaResposta(res)
      const conteudo = await corpoAte(res, limite)
      return { conteudo, mime: typeof corpo?.mime_type === 'string' ? corpo.mime_type : null }
    },
    enviarTexto(para, texto) {
      return mensagem({ to: destino(para), type: 'text', text: { body: texto } })
    },
    async enviarDocumento(para, anexo, legenda) {
      const id = await subirMidia(anexo)
      return mensagem({ to: destino(para), type: 'document', document: { id, filename: anexo.nome, caption: legenda } })
    },
    enviarModelo(para, nome, parametros) {
      const template: Record<string, unknown> = { name: nome, language: { code: IDIOMA_DOS_MODELOS } }
      if (parametros.length) {
        template.components = [{ type: 'body', parameters: parametros.map((text) => ({ type: 'text', text })) }]
      }
      return mensagem({ to: destino(para), type: 'template', template })
    },
  }
}
