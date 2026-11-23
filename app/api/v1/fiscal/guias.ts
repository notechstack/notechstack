// /api/v1/fiscal/guias: aba "Guias" do painel "Minha conta" (módulo Guias, conta Escritório com o módulo ligado). O site
// chega aqui por /agentes/fiscal/api/v1/fiscal/guias/ (rewrite do vercel.json da raiz). Sessão: `SUPABASE_URL` e
// `SUPABASE_ANON_KEY`; banco: `NOFISCAL_DATABASE_URL` (papel `nofiscal_service`); Storage: `FISCAL_GUIAS_STORAGE_*`
// (só assina URLs: o PDF vai do navegador direto ao Storage). Lógica em _lib/guias/painel.ts.
import { dbFromEnv } from '../../_lib/db.js'
import { leitorFromEnv } from '../../_lib/guias/ambiente.js'
import { handlePainelGuias } from '../../_lib/guias/painel.js'
import { storageFromEnv } from '../../_lib/guias/storage.js'
import { errorResponse } from '../../_lib/http.js'
import { logEvent } from '../../_lib/log.js'
import { sessionVerifierFromEnv } from '../../_lib/session.js'

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handlePainelGuias(request, {
        db: dbFromEnv(),
        sessions: sessionVerifierFromEnv(),
        storage: storageFromEnv(),
        leitor: leitorFromEnv(),
      })
    } catch {
      logEvent('guias.painel_unavailable')
      return errorResponse('INTERNAL', 'erro interno')
    }
  },
}
