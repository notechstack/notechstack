// POST /api/v1/onboarding/clientes: base de clientes do onboarding (critérios 19 a 23 do agente
// fiscal v2). Banco: `NOFISCAL_DATABASE_URL` (papel `nofiscal_service`); sessão: `SUPABASE_URL` e
// `SUPABASE_ANON_KEY`; IA: `ANTHROPIC_API_KEY`, `AGENTE_FISCAL_IA_MODELO` e `ANTHROPIC_BASE_URL`
// (opcional); ADN: mTLS com o A1 do tenant.
import { createAdnClient } from '../../_lib/adn.js'
import { dbFromEnv } from '../../_lib/db.js'
import { errorResponse } from '../../_lib/http.js'
import { iaFromEnv } from '../../_lib/ia/claude.js'
import { leitorPdfClaude } from '../../_lib/ia/leitor-pdf.js'
import { logEvent } from '../../_lib/log.js'
import { handleOnboardingClientes } from '../../_lib/onboarding-clientes.js'
import { sessionVerifierFromEnv } from '../../_lib/session.js'

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const ia = iaFromEnv()
      return await handleOnboardingClientes(request, {
        db: dbFromEnv('NOFISCAL_DATABASE_URL'),
        sessions: sessionVerifierFromEnv(),
        adn: createAdnClient(),
        leitor: ia ? leitorPdfClaude(ia) : null,
      })
    } catch {
      logEvent('nofiscal.onboarding_clientes_unavailable')
      return errorResponse('INTERNAL', 'erro interno')
    }
  },
}
