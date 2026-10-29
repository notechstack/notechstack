// Webhook da Meta (critérios 23 e 24; Landing, lote B - webhook da Meta: forma). Fonte:
// developers.facebook.com, "Webhooks – Getting started" (verificação com `hub.mode`,
// `hub.verify_token` e `hub.challenge`; `X-Hub-Signature-256: sha256=<HMAC-SHA256 do corpo
// com o App Secret>`; responder 200 e deduplicar, porque a Meta reentrega por até 36 horas)
// e "WhatsApp Cloud API – Webhooks" (`entry[].changes[].value.messages[]` e `statuses[]`). Cada mensagem e
// cada marca de envio vão para a central de conversas antes da conversa (29/10/2026).
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Queryable } from '../db.js'
import { errorResponse, json } from '../http.js'
import { logEvent } from '../log.js'
import { gravarEntrada, gravarMarca, type MarcaDeEnvio, type StatusDoEnvio } from './central.js'
import { processarMensagem, type ConversaDeps, type MensagemRecebida } from './conversa.js'
import { comNonoDigito } from './normalizacao.js'

export type WebhookDeps = {
  verifyToken: string | undefined
  appSecret: string | undefined
  /** `WHATSAPP_PHONE_NUMBER_ID`: só as mensagens para este número entram na conversa. A assinatura do app vale
   * para a conta inteira, e outro número da conta (o do atendimento, em coexistência) fica com a equipe. */
  phoneNumberId?: string
  /** Montada só depois da assinatura conferida e só se houver mensagem. */
  conversa: () => ConversaDeps
  /** Banco da central de conversas para as marcas de envio (`statuses[]`) que chegam sem mensagem. */
  central?: () => Queryable
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

/** Os `value` de `entry[].changes[]`; com `phoneNumberId`, só os do número do robô (`value.metadata.phone_number_id`). */
function valoresDoNumero(corpo: unknown, campo: 'messages' | 'statuses', phoneNumberId?: string): unknown[][] {
  const raiz = obj(corpo)
  if (!raiz || raiz.object !== 'whatsapp_business_account') return []
  const valores: unknown[][] = []
  for (const entrada of lista(raiz.entry)) {
    for (const mudanca of lista(obj(entrada)?.changes)) {
      const valor = obj(obj(mudanca)?.value)
      const brutas = lista(valor?.[campo])
      if (!brutas.length) continue
      if (phoneNumberId && textoOuNulo(obj(valor?.metadata)?.phone_number_id) !== phoneNumberId) {
        if (campo === 'messages') logEvent('agente.mensagem_ignorada', { motivo: 'outro número da conta', quantidade: brutas.length })
        continue
      }
      valores.push(brutas)
    }
  }
  return valores
}

/** `entry[].changes[].value.messages[]` → mensagens para a conversa; com `phoneNumberId`, só as do número do robô. */
export function mensagensDaNotificacao(corpo: unknown, phoneNumberId?: string): MensagemRecebida[] {
  const mensagens: MensagemRecebida[] = []
  for (const brutas of valoresDoNumero(corpo, 'messages', phoneNumberId)) {
    for (const bruta of brutas) {
      const m = obj(bruta)
      const id = textoOuNulo(m?.id)
      const de = textoOuNulo(m?.from)?.replace(/\D/g, '')
      if (!m || !id || !de) {
        logEvent('agente.mensagem_ignorada', { motivo: 'sem id ou remetente' })
        continue
      }
      const tipo = textoOuNulo(m.type) ?? 'unknown'
      const documento = obj(m.document)
      // O vínculo número → conta usa o número com o 9; a resposta volta para o endereço exato que a Meta mandou.
      mensagens.push({
        id,
        de: comNonoDigito(`+${de}`),
        enderecoRecebido: `+${de}`,
        tipo,
        texto: tipo === 'text' ? textoOuNulo(obj(m.text)?.body) : null,
        arquivo: documento ? { nome: textoOuNulo(documento.filename), mime: textoOuNulo(documento.mime_type) } : null,
      })
    }
  }
  return mensagens
}

const STATUS_DA_META: Record<string, StatusDoEnvio> = { sent: 'enviada', delivered: 'entregue', read: 'lida', failed: 'falhou' }

/** `statuses[]` → marcas de envio (`sent`, `delivered`, `read`, `failed` com `errors[]`); as outras são ignoradas. */
export function marcasDaNotificacao(corpo: unknown, phoneNumberId?: string): MarcaDeEnvio[] {
  const marcas: MarcaDeEnvio[] = []
  for (const brutas of valoresDoNumero(corpo, 'statuses', phoneNumberId)) {
    for (const bruta of brutas) {
      const m = obj(bruta)
      const wamid = textoOuNulo(m?.id)
      const status = STATUS_DA_META[textoOuNulo(m?.status) ?? '']
      if (!m || !wamid || !status) continue
      const para = textoOuNulo(m.recipient_id)?.replace(/\D/g, '')
      const erro = obj(lista(m.errors)[0])
      const detalhe = erro ? [erro.code, textoOuNulo(obj(erro.error_data)?.details) ?? textoOuNulo(erro.title) ?? textoOuNulo(erro.message)] : []
      marcas.push({
        wamid,
        status,
        para: para ? `+${para}` : null,
        erro: detalhe.filter((parte) => parte !== null && parte !== undefined && parte !== '').join(' · ') || null,
      })
    }
  }
  return marcas
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
  const mensagens = mensagensDaNotificacao(notificacao, deps.phoneNumberId)
  const marcas = marcasDaNotificacao(notificacao, deps.phoneNumberId)
  if (!mensagens.length && !marcas.length) return json(200, { ok: true })

  // A central de conversas nunca segura a conversa: o que não grava fica só no log.
  const naCentral = (gravar: () => Promise<void>) =>
    Promise.resolve()
      .then(gravar)
      .catch((error: unknown) =>
        logEvent('agente.mensagem_nao_gravada', { direcao: 'entrada', error_name: error instanceof Error ? error.name : 'unknown' }),
      )
  const conversa = mensagens.length ? deps.conversa() : null
  if (marcas.length) {
    await naCentral(async () => {
      const db = conversa?.db ?? deps.central?.()
      for (const marca of db ? marcas : []) await gravarMarca(db as Queryable, marca)
    })
  }
  if (!conversa) return json(200, { ok: true })
  for (const mensagem of mensagens) {
    try {
      // Gravada antes da conversa: a central mostra a mensagem mesmo que a conversa falhe.
      await naCentral(() => gravarEntrada(conversa.db, mensagem))
      await processarMensagem(conversa, mensagem)
    } catch (error) {
      // A marca da mensagem foi desfeita: a reentrega da Meta tenta de novo.
      logEvent('agente.mensagem_falhou', { message_id: mensagem.id, error_name: error instanceof Error ? error.name : 'unknown' })
      return errorResponse('INTERNAL', 'erro interno')
    }
  }
  return json(200, { ok: true })
}
