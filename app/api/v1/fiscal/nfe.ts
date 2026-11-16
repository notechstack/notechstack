// /api/v1/fiscal/nfe: aba "NF-e" do painel "Minha conta" do site (o site chega aqui por
// /agentes/fiscal/api/v1/fiscal/nfe/, reescrito no vercel.json da raiz). Sessão: `SUPABASE_URL` e `SUPABASE_ANON_KEY`;
// banco: `NOFISCAL_DATABASE_URL` (papel `nofiscal_service`). A conferência fala com a Sefaz da UF com o A1 da própria
// empresa (`criarSefazClient`). Lógica em _lib/nfe/painel-nfe.ts.
import { dbFromEnv } from '../../_lib/db.js'
import { errorResponse } from '../../_lib/http.js'
import { logEvent } from '../../_lib/log.js'
import { handlePainelNfe } from '../../_lib/nfe/painel-nfe.js'
import { criarSefazClient } from '../../_lib/nfe/sefaz-client.js'
import { responsavelTecnicoFromEnv } from '../../_lib/nfe/servico.js'
import { sessionVerifierFromEnv } from '../../_lib/session.js'

const sefaz = criarSefazClient()

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handlePainelNfe(request, {
        db: dbFromEnv(),
        sessions: sessionVerifierFromEnv(),
        sefaz,
        responsavelTecnico: responsavelTecnicoFromEnv(),
      })
    } catch {
      logEvent('nofiscal.painel_nfe_unavailable')
      return errorResponse('INTERNAL', 'erro interno')
    }
  },
}
