// GET e POST /api/v1/onboarding/procuracao: cadastro por procuração eletrônica (migração 20261111180000).
// Bancos: `NOFISCAL_ONBOARDING_DATABASE_URL` (papel `nofiscal_onboarding`, declaração) e `NOFISCAL_DATABASE_URL`
// (papel `nofiscal_service`, conferência no ADN com o A1 do procurador); sessão: `SUPABASE_URL` e `SUPABASE_ANON_KEY`.
import { createAdnClient } from '../../_lib/adn.js'
import { dbFromEnv } from '../../_lib/db.js'
import { errorResponse } from '../../_lib/http.js'
import { logEvent } from '../../_lib/log.js'
import { handleOnboardingProcuracao } from '../../_lib/onboarding-procuracao.js'
import { sessionVerifierFromEnv } from '../../_lib/session.js'

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handleOnboardingProcuracao(request, {
        db: dbFromEnv('NOFISCAL_ONBOARDING_DATABASE_URL'),
        servico: dbFromEnv('NOFISCAL_DATABASE_URL'),
        adn: createAdnClient(),
        sessions: sessionVerifierFromEnv(),
      })
    } catch {
      logEvent('nofiscal.onboarding_unavailable')
      return errorResponse('INTERNAL', 'erro interno')
    }
  },
}
