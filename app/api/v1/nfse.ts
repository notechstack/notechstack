// API pública do nó.fiscal, base https://app.notechstack.com.br/api: NFS-e (/v1/nfse), NF-e (/v1/nfe) e empresas da
// conta (/v1/empresas). Uma função para todas as rotas; o vercel.json reescreve as formas com id para cá. Rotas e
// documentação: _lib/nfse-routes.ts e agentes/fiscal/dados/api/.
import { consultaCnpjBrasilApi } from '../_lib/agente/consulta-cnpj.js'
import { dbFromEnv } from '../_lib/db.js'
import { errorResponse } from '../_lib/http.js'
import { logEvent } from '../_lib/log.js'
import { handleNfseRequest } from '../_lib/nfse-routes.js'

// Endereço do tomador com ISS retido (E0237): a mesma BrasilAPI do agente e do painel (`CNPJ_API_URL` opcional).
const consulta = consultaCnpjBrasilApi({ baseUrl: process.env.CNPJ_API_URL })
const enderecos = { endereco: (cnpj: string) => (consulta.endereco ? consulta.endereco(cnpj) : Promise.resolve(null)) }

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handleNfseRequest(request, { db: dbFromEnv(), enderecos })
    } catch {
      logEvent('nofiscal.api_unavailable')
      return errorResponse('INTERNAL', 'erro interno')
    }
  },
}
