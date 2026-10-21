// POST /api/v1/onboarding/ativacao: código para concluir o cadastro no WhatsApp (critério 25 do
// agente fiscal v2). Banco: `NOFISCAL_DATABASE_URL` (papel `nofiscal_service`); sessão:
// `SUPABASE_URL` e `SUPABASE_ANON_KEY`; link: `WHATSAPP_NUMERO_AGENTE`.
import { handleAtivacao } from '../../_lib/agente/rota-ativacao.js'
import { dbFromEnv } from '../../_lib/db.js'
import { errorResponse } from '../../_lib/http.js'
import { logEvent } from '../../_lib/log.js'
import { sessionVerifierFromEnv } from '../../_lib/session.js'

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handleAtivacao(request, {
        db: dbFromEnv(),
        sessions: sessionVerifierFromEnv(),
        numeroDoAgente: process.env.WHATSAPP_NUMERO_AGENTE,
      })
    } catch {
      logEvent('agente.ativacao_unavailable')
      return errorResponse('INTERNAL', 'erro interno')
    }
  },
}
