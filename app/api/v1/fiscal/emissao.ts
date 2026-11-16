// POST /api/v1/fiscal/emissao: aba "Emitir" do painel "Minha conta" do site (o site chega aqui por
// /agentes/fiscal/api/v1/fiscal/emissao/, reescrito no vercel.json da raiz). Sessão: `SUPABASE_URL` e
// `SUPABASE_ANON_KEY`; banco: `NOFISCAL_DATABASE_URL` (papel `nofiscal_service`, o do agente); nome do código de
// serviço: a lista publicada pelo site (`AGENTE_FISCAL_SITE_URL`). Lógica em _lib/painel-emissao.ts.
import { catalogoDoSite } from '../../_lib/agente/catalogo-servicos.js'
import { linksFromEnv } from '../../_lib/agente/links.js'
import { dbFromEnv } from '../../_lib/db.js'
import { errorResponse } from '../../_lib/http.js'
import { logEvent } from '../../_lib/log.js'
import { handlePainelEmissao } from '../../_lib/painel-emissao.js'
import { sessionVerifierFromEnv } from '../../_lib/session.js'

const catalogo = catalogoDoSite({ site: linksFromEnv().site })

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handlePainelEmissao(request, {
        db: dbFromEnv(),
        sessions: sessionVerifierFromEnv(),
        catalogo,
      })
    } catch {
      logEvent('nofiscal.painel_emissao_unavailable')
      return errorResponse('INTERNAL', 'erro interno')
    }
  },
}
