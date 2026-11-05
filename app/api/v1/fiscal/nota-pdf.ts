// GET /api/v1/fiscal/nota-pdf?invoice_id=<uuid>: DANFSe da nota para o painel "Minha conta" do site (o site chega
// aqui por /agentes/fiscal/api/v1/fiscal/nota-pdf/, reescrito no vercel.json da raiz). Sessão: `SUPABASE_URL` e
// `SUPABASE_ANON_KEY`; banco: `NOFISCAL_DATABASE_URL` (papel `nofiscal_service`). Lógica em _lib/nota-pdf.ts.
import { dbFromEnv } from '../../_lib/db.js'
import { errorResponse } from '../../_lib/http.js'
import { logEvent } from '../../_lib/log.js'
import { handleNotaPdf } from '../../_lib/nota-pdf.js'
import { sessionVerifierFromEnv } from '../../_lib/session.js'

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handleNotaPdf(request, {
        db: dbFromEnv(),
        sessions: sessionVerifierFromEnv(),
      })
    } catch {
      logEvent('nofiscal.nota_pdf_unavailable')
      return errorResponse('INTERNAL', 'erro interno')
    }
  },
}
