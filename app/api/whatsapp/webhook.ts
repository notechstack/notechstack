// GET e POST /api/whatsapp/webhook: verificação e notificações da Meta (critérios 23 e 24 do
// agente fiscal). Segredos: `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`; envio:
// `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`; banco: `NOFISCAL_DATABASE_URL`
// (papel `nofiscal_service`). Lidos a cada chamada.
import { conversaFromEnv } from '../_lib/agente/ambiente.js'
import { handleWhatsAppWebhook } from '../_lib/agente/webhook.js'
import { errorResponse } from '../_lib/http.js'
import { logEvent } from '../_lib/log.js'

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handleWhatsAppWebhook(request, {
        verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
        appSecret: process.env.WHATSAPP_APP_SECRET,
        conversa: conversaFromEnv,
      })
    } catch {
      logEvent('agente.webhook_unavailable')
      return errorResponse('INTERNAL', 'erro interno')
    }
  },
}
