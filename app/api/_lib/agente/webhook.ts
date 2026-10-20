// Webhook da Meta (critérios 23 e 24; Landing, lote B - webhook da Meta: forma). Fonte:
// developers.facebook.com, "Webhooks – Getting started" (verificação com `hub.mode`,
// `hub.verify_token` e `hub.challenge`; `X-Hub-Signature-256: sha256=<HMAC-SHA256 do corpo
// com o App Secret>`; responder 200 e deduplicar, porque a Meta reentrega por até 36 horas)
// e "WhatsApp Cloud API – Webhooks" (`entry[].changes[].value.messages[]`).
import { createHmac, timingSafeEqual } from 'node:crypto'
import { errorResponse, json } from '../http.js'
import { logEvent } from '../log.js'
import { processarMensagem, type ConversaDeps, type MensagemRecebida } from './conversa.js'

export type WebhookDeps = {
  verifyToken: string | undefined
  appSecret: string | undefined
  /** Montada só depois da assinatura conferida e só se houver mensagem. */
  conversa: () => ConversaDeps
}

function iguais(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

export function assinaturaValida(corpo: Uint8Array, header: string | null, segredo: string | undefined): boolean {
  if (!segredo || !header) return false
  const esperada = `sha256=${createHmac('sha256', segredo).update(corpo).digest('hex')}`
  return iguais(esperada, header.trim())
}

function verificar(url: URL, token: string | undefined): Response {
  const modo = url.searchParams.get('hub.mode')
  const recebido = url.searchParams.get('hub.verify_token')
  const desafio = url.searchParams.get('hub.challenge')
  if (!token || modo !== 'subscribe' || !recebido || desafio === null || !iguais(recebido, token)) {
    return errorResponse('FORBIDDEN', 'verificação recusada')
  }
  return new Response(desafio, { status: 200, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } })
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null)
const lista = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const textoOuNulo = (v: unknown) => (typeof v === 'string' ? v : null)

/** `entry[].changes[].value.messages[]` → mensagens para a conversa. `statuses` é ignorado. */
export function mensagensDaNotificacao(corpo: unknown): MensagemRecebida[] {
  const raiz = obj(corpo)
  if (!raiz || raiz.object !== 'whatsapp_business_account') return []
  const mensagens: MensagemRecebida[] = []
  for (const entrada of lista(raiz.entry)) {
    for (const mudanca of lista(obj(entrada)?.changes)) {
      for (const bruta of lista(obj(obj(mudanca)?.value)?.messages)) {
        const m = obj(bruta)
        const id = textoOuNulo(m?.id)
        const de = textoOuNulo(m?.from)?.replace(/\D/g, '')
        if (!m || !id || !de) {
          logEvent('agente.mensagem_ignorada', { motivo: 'sem id ou remetente' })
          continue
        }
        const tipo = textoOuNulo(m.type) ?? 'unknown'
        const documento = obj(m.document)
        mensagens.push({
          id,
          de: `+${de}`,
          tipo,
          texto: tipo === 'text' ? textoOuNulo(obj(m.text)?.body) : null,
          arquivo: documento ? { nome: textoOuNulo(documento.filename), mime: textoOuNulo(documento.mime_type) } : null,
        })
      }
    }
  }
  return mensagens
}

export async function handleWhatsAppWebhook(request: Request, deps: WebhookDeps): Promise<Response> {
  if (request.method === 'GET') return verificar(new URL(request.url), deps.verifyToken)
  if (request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'use GET ou POST')

  // Bytes crus: a assinatura é sobre eles, antes de qualquer leitura do JSON ou do banco.
  const corpo = new Uint8Array(await request.arrayBuffer())
  if (!assinaturaValida(corpo, request.headers.get('x-hub-signature-256'), deps.appSecret)) {
    logEvent('agente.webhook_assinatura_recusada')
    return errorResponse('UNAUTHORIZED', 'assinatura ausente ou inválida')
  }

  let notificacao: unknown
  try {
    notificacao = JSON.parse(Buffer.from(corpo).toString('utf8'))
  } catch {
    return errorResponse('INVALID_JSON', 'corpo não é JSON')
  }
  const mensagens = mensagensDaNotificacao(notificacao)
  if (!mensagens.length) return json(200, { ok: true })

  const conversa = deps.conversa()
  for (const mensagem of mensagens) {
    try {
      await processarMensagem(conversa, mensagem)
    } catch (error) {
      // A marca da mensagem foi desfeita: a reentrega da Meta tenta de novo.
      logEvent('agente.mensagem_falhou', { message_id: mensagem.id, error_name: error instanceof Error ? error.name : 'unknown' })
      return errorResponse('INTERNAL', 'erro interno')
    }
  }
  return json(200, { ok: true })
}
