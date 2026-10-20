// API pública do Nó Fiscal: POST /v1/nfse, GET /v1/nfse/:id, POST /v1/nfse/:id/cancel e
// GET /v1/nfse/:id/pdf (tabela Surface da tarefa), base https://app.notechstack.com.br/api.
// Uma função para as quatro rotas; o vercel.json reescreve /api/v1/nfse/:id[/:acao] para cá.
import { dbFromEnv } from '../_lib/db.js'
import { errorResponse } from '../_lib/http.js'
import { logEvent } from '../_lib/log.js'
import { handleNfseRequest } from '../_lib/nfse-routes.js'

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handleNfseRequest(request, { db: dbFromEnv() })
    } catch {
      logEvent('nofiscal.api_unavailable')
      return errorResponse('INTERNAL', 'erro interno')
    }
  },
}
