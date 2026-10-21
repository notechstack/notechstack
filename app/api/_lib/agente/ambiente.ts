// Configuração do agente a partir do ambiente da Vercel (nomes no Landing, lote B). Sem os
// segredos (Unresolved 9), o webhook recusa e o worker deixa o agente de fora.
import { dbFromEnv } from '../db.js'
import { logEvent } from '../log.js'
import type { EnviaWhatsApp } from './canais.js'
import type { ConversaDeps } from './conversa.js'
import { iaFromEnv } from '../ia/claude.js'
import { interpreteNaoConfigurado, type Interprete } from './interprete.js'
import { interpreteClaude } from './interprete-claude.js'
import { linksFromEnv } from './links.js'
import { emailResend } from './resend.js'
import type { AgenteDeps } from './tarefas.js'
import { whatsappCloud } from './whatsapp-cloud.js'

function whatsappFromEnv(): EnviaWhatsApp | null {
  const token = process.env.WHATSAPP_ACCESS_TOKEN
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID
  return token && phoneNumberId ? whatsappCloud({ token, phoneNumberId }) : null
}

/** Conversa do webhook. Sem `ANTHROPIC_API_KEY`, o intérprete fica desligado (v1). */
export function conversaFromEnv(): ConversaDeps {
  const whatsapp = whatsappFromEnv()
  if (!whatsapp) throw new Error('WHATSAPP_ACCESS_TOKEN ou WHATSAPP_PHONE_NUMBER_ID não configurada')
  return { db: dbFromEnv(), whatsapp, interprete: interpreteFromEnv(), links: linksFromEnv() }
}

/** Intérprete por Claude com a chave da IA; sem ela, `interpreteNaoConfigurado()` (critério 49). */
export function interpreteFromEnv(env: NodeJS.ProcessEnv = process.env): Interprete {
  const ia = iaFromEnv(env)
  return ia ? interpreteClaude(ia) : interpreteNaoConfigurado()
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
