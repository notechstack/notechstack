// GET e POST /api/v1/fiscal/central: central de conversas do nó.fiscal (tela /no/fiscal/conversas). Só
// NO_ADMIN com segundo fator: sessão por `SUPABASE_URL` e `SUPABASE_ANON_KEY`. Banco: `NOFISCAL_DATABASE_URL`
// (papel `nofiscal_service`); envio pelo número do robô: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`.
import { whatsappFromEnv } from '../../_lib/agente/ambiente.js'
import { handleCentral } from '../../_lib/agente/rota-central.js'
import { dbFromEnv } from '../../_lib/db.js'
import { errorResponse } from '../../_lib/http.js'
import { logEvent } from '../../_lib/log.js'
import { adminVerifierFromEnv } from '../../_lib/session.js'

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handleCentral(request, {
        db: dbFromEnv(),
        admins: adminVerifierFromEnv(),
        whatsapp: whatsappFromEnv(),
      })
    } catch {
      logEvent('central.unavailable')
      return errorResponse('INTERNAL', 'erro interno')
    }
  },
}
