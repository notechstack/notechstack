// Configuração do módulo Guias a partir do ambiente da Vercel. Variáveis novas:
//   FISCAL_GUIAS_STORAGE_KEY   chave do Storage (service role do projeto), só para o bucket fiscal-guias
//   FISCAL_GUIAS_STORAGE_URL   URL do Storage (padrão: SUPABASE_URL); FISCAL_GUIAS_STORAGE_URL_PUBLICA a que o navegador vê
//   GUIAS_LINK_SEGREDO         segredo do token do link /g/<token> (32+ caracteres aleatórios)
//   GUIAS_LINK_BASE_URL        onde mora /g/ (padrão https://app.notechstack.com.br)
//   GUIAS_TETO_DIARIO          contatos únicos no WhatsApp em 24 h, somados entre escritórios (padrão 200)
// Sem Storage ou sem segredo, o worker deixa o módulo de fora (e loga); o painel responde 503 no upload.
import type { Db } from '../db.js'
import { logEvent } from '../log.js'
import { emailResend } from '../agente/resend.js'
import { whatsappCloud } from '../agente/whatsapp-cloud.js'
import { iaFromEnv } from '../ia/claude.js'
import { TETO_DIARIO_PADRAO, type GuiasWorkerDeps } from './envio.js'
import { leitorGuiaClaude } from './leitor-ia.js'
import type { LerGuiaDeps } from './leitura.js'
import { storageFromEnv } from './storage.js'
import { textoDoPdf } from './texto-pdf.js'

export const LINK_BASE_PADRAO = 'https://app.notechstack.com.br'

export function leitorFromEnv(env: NodeJS.ProcessEnv = process.env): LerGuiaDeps {
  const ia = iaFromEnv(env)
  return { texto: textoDoPdf, ia: ia ? leitorGuiaClaude(ia) : null }
}

export function tetoFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.GUIAS_TETO_DIARIO)
  return Number.isInteger(n) && n > 0 ? n : TETO_DIARIO_PADRAO
}

export function guiasWorkerFromEnv(db: Db, env: NodeJS.ProcessEnv = process.env): GuiasWorkerDeps | null {
  const storage = storageFromEnv(env)
  const segredo = env.GUIAS_LINK_SEGREDO
  if (!storage || !segredo || segredo.length < 32) {
    logEvent('guias.nao_configurado', { storage: Boolean(storage), segredo: Boolean(segredo && segredo.length >= 32) })
    return null
  }
  const token = env.WHATSAPP_ACCESS_TOKEN
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID
  const apiKey = env.RESEND_API_KEY
  return {
    db,
    storage,
    whatsapp: token && phoneNumberId ? whatsappCloud({ token, phoneNumberId, graphUrl: env.WHATSAPP_GRAPH_URL || undefined }) : null,
    email: apiKey ? emailResend({ apiKey, from: env.AGENTE_FISCAL_EMAIL_FROM || undefined, baseUrl: env.RESEND_API_URL || undefined }) : null,
    leitor: leitorFromEnv(env),
    segredo,
    linkBase: env.GUIAS_LINK_BASE_URL || LINK_BASE_PADRAO,
    teto: tetoFromEnv(env),
  }
}
