// GET /g/<token> (rewrite em app/vercel.json → /api/v1/fiscal/guia-link?token=<token>): página pública do link
// rastreável de uma guia (módulo Guias). Banco: `NOFISCAL_DATABASE_URL`; PDF por URL assinada do Storage
// (`FISCAL_GUIAS_STORAGE_*`). Lógica em _lib/guias/link.ts.
import { dbFromEnv } from '../../_lib/db.js'
import { handleLinkDaGuia } from '../../_lib/guias/link.js'
import { storageFromEnv } from '../../_lib/guias/storage.js'
import { logEvent } from '../../_lib/log.js'

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handleLinkDaGuia(request, { db: dbFromEnv(), storage: storageFromEnv() })
    } catch {
      logEvent('guias.link_unavailable')
      return new Response('Não deu para abrir agora. Tente de novo em alguns minutos.', {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    }
  },
}
