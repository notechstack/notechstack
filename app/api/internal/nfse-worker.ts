// Worker do motor: chamado pelo agendador com `Authorization: Bearer ${CRON_SECRET}`.
// Não é rota pública da API (fica fora da tabela Surface). Com os canais do agente fiscal
// configurados, também entrega as notas dos tenants self-service e roda as tarefas do agente
// (os envios ficam na central de conversas). Com o Storage e o segredo do link, roda também o módulo Guias.
import { createAdnClient } from '../_lib/adn.js'
import { agenteFromEnv } from '../_lib/agente/ambiente.js'
import { dbFromEnv } from '../_lib/db.js'
import { guiasWorkerFromEnv } from '../_lib/guias/ambiente.js'
import { errorResponse } from '../_lib/http.js'
import { logEvent } from '../_lib/log.js'
import { criarSefazClient } from '../_lib/nfe/sefaz-client.js'
import { responsavelTecnicoFromEnv } from '../_lib/nfe/servico.js'
import { sefinClientFromEnv } from '../_lib/sefin-client.js'
import { handleWorkerRequest } from '../_lib/worker-route.js'

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const db = dbFromEnv()
      return await handleWorkerRequest(request, {
        db,
        sefin: sefinClientFromEnv(),
        cronSecret: process.env.CRON_SECRET,
        fetch: (url, init) => fetch(url, init),
        agente: agenteFromEnv(db) ?? undefined,
        adn: createAdnClient(),
        nfe: { sefaz: criarSefazClient(), responsavelTecnico: responsavelTecnicoFromEnv() },
        guias: guiasWorkerFromEnv(db) ?? undefined,
      })
    } catch {
      logEvent('nofiscal.worker_unavailable')
      return errorResponse('INTERNAL', 'erro interno')
    }
  },
}
