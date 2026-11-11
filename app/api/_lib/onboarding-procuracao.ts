// GET e POST /api/v1/onboarding/procuracao: cadastro por procuração eletrônica (migração 20261111180000).
//   GET  ?tenant_id=…  (ou POST { tenant_id, acao: 'consultar' }, que é o que a página usa)
//        → modo, procurador a indicar na Receita e a procuração gravada.
//   POST { tenant_id, acao: 'declarar', valida_ate?: 'AAAA-MM-DD' }
//        "Já fiz": grava a declaração, passa a empresa ao modo procuração e confere na hora no ADN.
//   POST { tenant_id, acao: 'conferir' }  → confere de novo no ADN (no máximo uma vez a cada 20 s).
// Sessão Supabase obrigatória. Declaração pelo papel `nofiscal_onboarding` (só executa as funções do cadastro);
// conferência pelo papel `nofiscal_service`, que lê o A1 do procurador. Nenhum certificado passa por aqui.
import type { DistribuicaoAdn } from './adn.js'
import type { Queryable } from './db.js'
import { errorResponse, json, type ErrorCode } from './http.js'
import { logEvent } from './log.js'
import { conferirProcuracao, type ResultadoConferencia } from './procuracao.js'
import type { SessionVerifier } from './session.js'

export type OnboardingProcuracaoDeps = {
  /** Papel `nofiscal_onboarding`. */
  db: Queryable
  /** Papel `nofiscal_service` (conferência no ADN). */
  servico: Queryable
  adn: DistribuicaoAdn
  sessions: SessionVerifier
  now?: () => Date
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATA = /^\d{4}-\d{2}-\d{2}$/
export const INTERVALO_MINIMO_CONFERIR_MS = 20_000

export type InfoProcuracao = {
  modo: 'certificado_proprio' | 'procuracao'
  cnpj: string
  procurador: { documento: string; nome: string | null; tipo: 'plataforma' | 'escritorio' } | null
  disponivel: boolean
  motivo: string | null
  procuracao: {
    status: 'declarada' | 'confirmada' | 'invalida' | 'revogada'
    valida_ate: string | null
    declarada_em: string
    conferida_em: string | null
    fonte_conferencia: string | null
    procurador_documento: string
    ultimo_erro: string | null
  } | null
}

const MOTIVOS: Record<string, string> = {
  PROCURADOR_NAO_CONFIGURADO: 'o cadastro por procuração ainda não está disponível',
  PROCURADOR_SEM_CERTIFICADO: 'o cadastro por procuração ainda não está disponível',
  PROCURADOR_CERT_VENCIDO: 'o cadastro por procuração está temporariamente indisponível',
  PROCURADOR_E_A_PROPRIA_EMPRESA: 'esta empresa não pode dar procuração a ela mesma; envie o certificado A1',
  ESCRITORIO_SEM_CERTIFICADO: 'o escritório precisa ter o próprio certificado A1 enviado para receber procurações',
}

export async function handleOnboardingProcuracao(request: Request, deps: OnboardingProcuracaoDeps): Promise<Response> {
  try {
    if (request.method === 'GET') return await consultar(request, deps)
    if (request.method === 'POST') return await alterar(request, deps)
    return errorResponse('METHOD_NOT_ALLOWED', 'use GET ou POST')
  } catch (error) {
    logEvent('nofiscal.onboarding_procuracao_error', { error_name: error instanceof Error ? error.name : 'unknown' })
    return errorResponse('INTERNAL', 'erro interno')
  }
}

async function info(deps: OnboardingProcuracaoDeps, userId: string, tenantId: string): Promise<InfoProcuracao | null> {
  const { rows } = await deps.db.query<{ info: (InfoProcuracao & { erro?: string }) | null }>(
    'select nofiscal.onboarding_procuracao_info($1, $2) as info',
    [userId, tenantId],
  )
  const dados = rows[0]?.info
  if (!dados || dados.erro) return null
  return dados
}

async function consultar(request: Request, deps: OnboardingProcuracaoDeps): Promise<Response> {
  const userId = await deps.sessions.userIdFrom(request)
  if (!userId) return falha('consultar', null, 'UNAUTHORIZED', 'faça login para continuar')
  const tenantId = new URL(request.url).searchParams.get('tenant_id')
  if (!tenantId || !UUID.test(tenantId)) return errorResponse('VALIDATION_FAILED', 'tenant_id inválido')
  const dados = await info(deps, userId, tenantId)
  if (!dados) return falha('consultar', tenantId, 'FORBIDDEN', 'você não é dono desta empresa')
  return json(200, dados)
}

async function alterar(request: Request, deps: OnboardingProcuracaoDeps): Promise<Response> {
  const userId = await deps.sessions.userIdFrom(request)
  if (!userId) return falha('declarar', null, 'UNAUTHORIZED', 'faça login para continuar')
  let corpo: Record<string, unknown>
  try {
    const lido = (await request.json()) as unknown
    if (typeof lido !== 'object' || lido === null || Array.isArray(lido)) throw new Error('corpo')
    corpo = lido as Record<string, unknown>
  } catch {
    return errorResponse('INVALID_JSON', 'envie JSON com tenant_id e acao')
  }
  const tenantId = corpo.tenant_id
  if (typeof tenantId !== 'string' || !UUID.test(tenantId)) return errorResponse('VALIDATION_FAILED', 'tenant_id inválido')
  const acao = corpo.acao ?? 'declarar'
  if (acao === 'consultar') {
    const dados = await info(deps, userId, tenantId)
    return dados ? json(200, dados) : falha('consultar', tenantId, 'FORBIDDEN', 'você não é dono desta empresa')
  }
  if (acao === 'conferir') return conferirDeNovo(deps, userId, tenantId)
  if (acao !== 'declarar') return errorResponse('VALIDATION_FAILED', 'acao deve ser consultar, declarar ou conferir')

  const validaAte = corpo.valida_ate ?? null
  if (validaAte !== null && (typeof validaAte !== 'string' || !DATA.test(validaAte) || Number.isNaN(Date.parse(validaAte)))) {
    return errorResponse('VALIDATION_FAILED', 'valida_ate deve ser uma data AAAA-MM-DD')
  }

  const { rows } = await deps.db.query<{ result: string }>(
    'select nofiscal.onboarding_set_procuracao($1, $2, $3::date) as result',
    [userId, tenantId, validaAte],
  )
  const resultado = rows[0]?.result
  if (resultado === 'FORBIDDEN') return falha('declarar', tenantId, 'FORBIDDEN', 'você não é dono desta empresa')
  if (resultado === 'RATE_LIMITED') return falha('declarar', tenantId, 'RATE_LIMITED', 'muitas tentativas; tente de novo em uma hora')
  if (resultado === 'VALIDADE_PASSADA') return falha('declarar', tenantId, 'VALIDADE_PASSADA', 'a data de validade já passou')
  if (resultado !== 'OK') {
    logEvent('nofiscal.onboarding_procuracao', { acao: 'declarar', tenant_id: tenantId, result: resultado ?? 'SEM_RESULTADO' })
    return errorResponse('PROCURADOR_INDISPONIVEL', MOTIVOS[resultado ?? ''] ?? 'o cadastro por procuração está indisponível agora')
  }
  logEvent('nofiscal.onboarding_procuracao', { acao: 'declarar', tenant_id: tenantId, result: 'OK' })
  const conferencia = await conferirSemFalhar(deps, tenantId)
  const dados = await info(deps, userId, tenantId)
  return json(200, { ...dados, conferencia })
}

async function conferirDeNovo(deps: OnboardingProcuracaoDeps, userId: string, tenantId: string): Promise<Response> {
  const antes = await info(deps, userId, tenantId)
  if (!antes) return falha('conferir', tenantId, 'FORBIDDEN', 'você não é dono desta empresa')
  if (!antes.procuracao) return errorResponse('NOT_FOUND', 'nenhuma procuração declarada para esta empresa')
  const agora = (deps.now ?? (() => new Date()))().getTime()
  const ultima = antes.procuracao.conferida_em ? Date.parse(antes.procuracao.conferida_em) : NaN
  if (!Number.isNaN(ultima) && agora - ultima < INTERVALO_MINIMO_CONFERIR_MS) {
    return json(200, { ...antes, conferencia: 'recente' })
  }
  const conferencia = await conferirSemFalhar(deps, tenantId)
  const dados = await info(deps, userId, tenantId)
  return json(200, { ...dados, conferencia })
}

async function conferirSemFalhar(deps: OnboardingProcuracaoDeps, tenantId: string): Promise<ResultadoConferencia> {
  try {
    return await conferirProcuracao({ db: deps.servico, adn: deps.adn, now: deps.now ?? (() => new Date()) }, tenantId)
  } catch (error) {
    logEvent('nofiscal.procuracao_conferencia', { tenant_id: tenantId, result: 'ERRO', error_name: error instanceof Error ? error.name : 'unknown' })
    return 'indisponivel'
  }
}

function falha(acao: string, tenantId: string | null, code: ErrorCode, message: string): Response {
  logEvent('nofiscal.onboarding_procuracao', { acao, tenant_id: tenantId, result: code })
  return errorResponse(code, message)
}
