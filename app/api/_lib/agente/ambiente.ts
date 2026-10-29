// Configuração do agente a partir do ambiente da Vercel (nomes no Landing, lote B da v1 e lote C
// da v2). Sem os segredos, o webhook recusa e o worker deixa o agente de fora. As URLs base têm
// a URL oficial como padrão (critério 56): `WHATSAPP_GRAPH_URL`, `RESEND_API_URL`, `CNPJ_API_URL`.
import { dbFromEnv } from '../db.js'
import { logEvent } from '../log.js'
import type { EnviaWhatsApp } from './canais.js'
import { catalogoDoSite } from './catalogo-servicos.js'
import { consultaCnpjBrasilApi } from './consulta-cnpj.js'
import { NUMERO_OFICIAL_DA_NO, type ConversaDeps } from './conversa.js'
import { iaFromEnv } from '../ia/claude.js'
import { interpreteNaoConfigurado, type Interprete } from './interprete.js'
import { interpreteClaude } from './interprete-claude.js'
import type { ModelosDoAgente } from './janela.js'
import { linksFromEnv } from './links.js'
import { emailResend } from './resend.js'
import type { AgenteDeps } from './tarefas.js'
import { whatsappCloud } from './whatsapp-cloud.js'

const variavel = (nome: string) => process.env[nome] || undefined

function whatsappFromEnv(): EnviaWhatsApp | null {
  const token = process.env.WHATSAPP_ACCESS_TOKEN
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID
  return token && phoneNumberId ? whatsappCloud({ token, phoneNumberId, graphUrl: variavel('WHATSAPP_GRAPH_URL') }) : null
}

/** O agente tem número próprio quando `WHATSAPP_NUMERO_AGENTE` não é o número oficial da Nó (o do atendimento). */
export function numeroProprioFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const agente = (env.WHATSAPP_NUMERO_AGENTE ?? '').replace(/\D/g, '')
  return agente !== '' && agente !== NUMERO_OFICIAL_DA_NO
}

export function modelosFromEnv(): ModelosDoAgente {
  return { boasVindas: variavel('WHATSAPP_MODELO_BOAS_VINDAS'), resumo: variavel('WHATSAPP_MODELO_RESUMO') }
}

/** Conversa do webhook. Sem `ANTHROPIC_API_KEY`, o intérprete fica desligado (v1). */
export function conversaFromEnv(): ConversaDeps {
  const whatsapp = whatsappFromEnv()
  if (!whatsapp) throw new Error('WHATSAPP_ACCESS_TOKEN ou WHATSAPP_PHONE_NUMBER_ID não configurada')
  const links = linksFromEnv()
  return {
    db: dbFromEnv(),
    whatsapp,
    interprete: interpreteFromEnv(),
    links,
    consultaCnpj: consultaCnpjBrasilApi({ baseUrl: variavel('CNPJ_API_URL') }),
    catalogo: catalogoDoSite({ site: links.site }),
    numeroProprio: numeroProprioFromEnv(),
  }
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
    email: emailResend({ apiKey, from: variavel('AGENTE_FISCAL_EMAIL_FROM'), baseUrl: variavel('RESEND_API_URL') }),
    links: linksFromEnv(),
    modelos: modelosFromEnv(),
    alertaEmail: variavel('FISCAL_ALERTA_EMAIL'),
  }
}
