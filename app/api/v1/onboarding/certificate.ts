// POST e DELETE /api/v1/onboarding/certificate: envio e remoção do A1 pelo dono, na página
// do cadastro (critérios 7 a 10 do agente fiscal). Substitui o critério 31 do motor
// ("nenhuma rota recebe PFX"). Banco: `NOFISCAL_ONBOARDING_DATABASE_URL` (papel
// `nofiscal_onboarding`); sessão: `SUPABASE_URL` e `SUPABASE_ANON_KEY`.
import { dbFromEnv } from '../../_lib/db.js'
import { errorResponse } from '../../_lib/http.js'
import { logEvent } from '../../_lib/log.js'
import { handleOnboardingCertificate } from '../../_lib/onboarding-certificate.js'
import { sessionVerifierFromEnv } from '../../_lib/session.js'

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handleOnboardingCertificate(request, {
        db: dbFromEnv('NOFISCAL_ONBOARDING_DATABASE_URL'),
        sessions: sessionVerifierFromEnv(),
      })
    } catch {
      logEvent('nofiscal.onboarding_unavailable')
      return errorResponse('INTERNAL', 'erro interno')
    }
  },
}
