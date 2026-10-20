// Configuração do agente a partir do ambiente da Vercel (nomes no Landing, lote B). Sem os
// segredos (Unresolved 9), o webhook recusa e o worker deixa o agente de fora.
import { dbFromEnv } from '../db.js'
import { logEvent } from '../log.js'
import type { EnviaWhatsApp } from './canais.js'
import type { ConversaDeps } from './conversa.js'
import { interpreteNaoConfigurado } from './interprete.js'
import { linksFromEnv } from './links.js'
import { emailResend } from './resend.js'
import type { AgenteDeps } from './tarefas.js'
import { whatsappCloud } from './whatsapp-cloud.js'

function whatsappFromEnv(): EnviaWhatsApp | null {
  const token = process.env.WHATSAPP_ACCESS_TOKEN
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID
  return token && phoneNumberId ? whatsappCloud({ token, phoneNumberId }) : null
}

/** Conversa do webhook. O intérprete fica desligado até o Unresolved 7. */
export function conversaFromEnv(): ConversaDeps {
  const whatsapp = whatsappFromEnv()
  if (!whatsapp) throw new Error('WHATSAPP_ACCESS_TOKEN ou WHATSAPP_PHONE_NUMBER_ID não configurada')
  return { db: dbFromEnv(), whatsapp, interprete: interpreteNaoConfigurado(), links: linksFromEnv() }
}

/** Canais do agente no worker; `null` (e o log) quando falta configuração. */
export function agenteFromEnv(): AgenteDeps | null {
  const whatsapp = whatsappFromEnv()
  const apiKey = process.env.RESEND_API_KEY
  if (!whatsapp || !apiKey) {
    logEvent('agente.nao_configurado', { whatsapp: Boolean(whatsapp), email: Boolean(apiKey) })
    return null
  }
  return {
    whatsapp,
    email: emailResend({ apiKey, from: process.env.AGENTE_FISCAL_EMAIL_FROM || undefined }),
    links: linksFromEnv(),
  }
}
