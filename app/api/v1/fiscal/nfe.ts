// /api/v1/fiscal/nfe: aba "NF-e" do painel "Minha conta" do site (o site chega aqui por
// /agentes/fiscal/api/v1/fiscal/nfe/, reescrito no vercel.json da raiz). Sessão: `SUPABASE_URL` e `SUPABASE_ANON_KEY`;
// banco: `NOFISCAL_DATABASE_URL` (papel `nofiscal_service`). Lógica em _lib/nfe/painel-nfe.ts.
import { dbFromEnv } from '../../_lib/db.js'
import { errorResponse } from '../../_lib/http.js'
import { logEvent } from '../../_lib/log.js'
import { handlePainelNfe } from '../../_lib/nfe/painel-nfe.js'
import { sessionVerifierFromEnv } from '../../_lib/session.js'

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handlePainelNfe(request, { db: dbFromEnv(), sessions: sessionVerifierFromEnv() })
    } catch {
      logEvent('nofiscal.painel_nfe_unavailable')
      return errorResponse('INTERNAL', 'erro interno')
    }
  },
}
