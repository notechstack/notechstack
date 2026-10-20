// Cliente real da WhatsApp Cloud API (Meta), atrás de `EnviaWhatsApp`. Nenhum teste o chama.
// Fonte: developers.facebook.com, "Cloud API – Messages" e "Media": `POST /{versão}/{Phone-Number-ID}/messages`
// e `POST /{versão}/{Phone-Number-ID}/media` (multipart `messaging_product`, `type`, `file` → `id`),
// com `Authorization: Bearer <token>`. Versão v26.0 (changelog da Graph API, 29/07/2026).
// O token e o corpo das respostas nunca vão para o log.
import type { AnexoEmail, EnviaWhatsApp } from './canais.js'

export const GRAPH_API = 'https://graph.facebook.com'
export const GRAPH_VERSION = 'v26.0'
const TIMEOUT_MS = 10_000

type FetchLike = typeof fetch

export class WhatsAppHttpError extends Error {
  constructor(readonly status: number) {
    super(`Cloud API respondeu ${status}`)
    this.name = 'WhatsAppHttpError'
  }
}

export function whatsappCloud(opcoes: { token: string; phoneNumberId: string; versao?: string; fetch?: FetchLike }): EnviaWhatsApp {
  const doFetch = opcoes.fetch ?? fetch
  const base = `${GRAPH_API}/${opcoes.versao ?? GRAPH_VERSION}/${encodeURIComponent(opcoes.phoneNumberId)}`
  const autorizacao = { authorization: `Bearer ${opcoes.token}` }
  // A Cloud API endereça o número só com dígitos, como chega em `messages[].from`.
  const destino = (para: string) => para.replace(/\D/g, '')

  async function mensagem(corpo: Record<string, unknown>): Promise<void> {
    const res = await doFetch(`${base}/messages`, {
      method: 'POST',
      headers: { ...autorizacao, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...corpo }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) throw new WhatsAppHttpError(res.status)
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
    if (!res.ok) throw new WhatsAppHttpError(res.status)
    const corpo = (await res.json().catch(() => null)) as { id?: unknown } | null
    if (typeof corpo?.id !== 'string') throw new WhatsAppHttpError(res.status)
    return corpo.id
  }

  return {
    async enviarTexto(para, texto) {
      await mensagem({ to: destino(para), type: 'text', text: { body: texto } })
    },
    async enviarDocumento(para, anexo, legenda) {
      const id = await subirMidia(anexo)
      await mensagem({ to: destino(para), type: 'document', document: { id, filename: anexo.nome, caption: legenda } })
    },
  }
}
