// POST /api/v1/onboarding/ativacao (critério 25; Landing v2, lote C - rota de ativação: forma).
// Ordem: 401 → 422 → 403 → 409 → 500 sem número do agente → 201. Banco pelo `nofiscal_service`;
// o dono é conferido dentro de `nofiscal` (`fiscal_accounts.client_id` = `fiscal_tenants.client_id`).
import type { Db } from '../db.js'
import { errorResponse, json } from '../http.js'
import { logEvent } from '../log.js'
import type { SessionVerifier } from '../session.js'
import { gerarCodigoDeAtivacao } from './ativacao.js'

export type RotaAtivacaoDeps = {
  db: Db
  sessions: SessionVerifier
  numeroDoAgente: string | undefined
  now?: () => Date
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const conflito = (code: 'JA_ATIVADO' | 'ONBOARDING_INCOMPLETO', message: string) => json(409, { error: { code, message } })

export async function handleAtivacao(request: Request, deps: RotaAtivacaoDeps): Promise<Response> {
  if (request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'use POST')
  try {
    const userId = await deps.sessions.userIdFrom(request)
    if (!userId) return errorResponse('UNAUTHORIZED', 'faça login para ativar o WhatsApp')

    let corpo: unknown
    try {
      corpo = await request.json()
    } catch {
      return errorResponse('VALIDATION_FAILED', 'envie JSON com tenant_id')
    }
    const tenantId = (corpo as { tenant_id?: unknown } | null)?.tenant_id
    if (typeof tenantId !== 'string' || !UUID.test(tenantId)) return errorResponse('VALIDATION_FAILED', 'tenant_id inválido')

    const resultado = await gerarCodigoDeAtivacao(
      { db: deps.db, numeroDoAgente: deps.numeroDoAgente, now: deps.now },
      { userId, tenantId },
    )
    if (!resultado.ok) {
      if (resultado.erro === 'FORBIDDEN') return errorResponse('FORBIDDEN', 'você não é dono desta empresa')
      if (resultado.erro === 'JA_ATIVADO') return conflito('JA_ATIVADO', 'o WhatsApp desta empresa já está ativado')
      if (resultado.erro === 'SEM_NUMERO_DO_AGENTE') {
        logEvent('agente.numero_do_agente_ausente')
        return errorResponse('INTERNAL', 'erro interno')
      }
      return conflito('ONBOARDING_INCOMPLETO', 'termine o pagamento, o certificado e os dados fiscais antes')
    }
    logEvent('agente.codigo_de_ativacao', { tenant_id: tenantId })
    return json(201, { codigo: resultado.codigo, whatsapp_url: resultado.whatsappUrl, expira_em: resultado.expiraEm.toISOString() })
  } catch (error) {
    logEvent('agente.ativacao_erro', { error_name: error instanceof Error ? error.name : 'unknown' })
    return errorResponse('INTERNAL', 'erro interno')
  }
}
