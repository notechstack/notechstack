// POST e DELETE /api/v1/onboarding/certificate (critérios 7 a 10; forma literal no Landing de
// .checks/agente-fiscal-whatsapp.md, lote A - rota do certificado).
// Banco só pelo papel `nofiscal_onboarding`, que executa apenas
// `nofiscal.onboarding_set_certificate` e `nofiscal.onboarding_delete_certificate`; elas
// conferem `memberships`, contam as tentativas e devolvem um código.
// Ordem: 401 → 403 → 429 → 422. O PFX e a senha nunca vão para log nem resposta.
import { lerCertificadoA1 } from './certificado-a1.js'
import type { Queryable } from './db.js'
import { errorResponse, json, type ErrorCode } from './http.js'
import { logEvent } from './log.js'
import type { SessionVerifier } from './session.js'

export type OnboardingCertificateDeps = {
  /** Conexão como `nofiscal_onboarding`. */
  db: Queryable
  sessions: SessionVerifier
  now?: () => Date
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_PFX_BYTES = 64 * 1024

type DbResult = 'OK' | 'FORBIDDEN' | 'RATE_LIMITED' | 'INVALID' | 'CERT_VENCIDO' | 'CERT_CNPJ_DIFERENTE'

const MESSAGES: Partial<Record<ErrorCode, string>> = {
  UNAUTHORIZED: 'faça login para enviar o certificado',
  FORBIDDEN: 'você não é dono desta empresa',
  RATE_LIMITED: 'muitas tentativas; tente de novo em uma hora',
  CERT_SENHA_INVALIDA: 'a senha não abre este certificado',
  CERT_VENCIDO: 'este certificado está vencido',
  CERT_CNPJ_DIFERENTE: 'este certificado não é do CNPJ da empresa',
}

function fail(code: ErrorCode, message = MESSAGES[code] ?? 'requisição inválida'): Response {
  return errorResponse(code, message)
}

export async function handleOnboardingCertificate(request: Request, deps: OnboardingCertificateDeps): Promise<Response> {
  try {
    if (request.method === 'POST') return await upload(request, deps)
    if (request.method === 'DELETE') return await remove(request, deps)
    return fail('METHOD_NOT_ALLOWED', 'use POST ou DELETE')
  } catch (error) {
    // Só o nome do erro: a mensagem de um driver ou biblioteca pode ecoar parâmetros.
    logEvent('nofiscal.onboarding_certificate_error', { error_name: error instanceof Error ? error.name : 'unknown' })
    return fail('INTERNAL', 'erro interno')
  }
}

async function upload(request: Request, deps: OnboardingCertificateDeps): Promise<Response> {
  const userId = await deps.sessions.userIdFrom(request)
  if (!userId) return result('upload', null, 'UNAUTHORIZED')

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return fail('VALIDATION_FAILED', 'envie multipart/form-data com tenant_id, pfx e senha')
  }
  const tenantId = form.get('tenant_id')
  const pfx = form.get('pfx')
  const senha = form.get('senha')
  if (typeof tenantId !== 'string' || !UUID.test(tenantId)) return fail('VALIDATION_FAILED', 'tenant_id inválido')
  if (!(pfx instanceof Blob) || pfx.size === 0 || pfx.size > MAX_PFX_BYTES) {
    return fail('VALIDATION_FAILED', 'pfx ausente ou maior que 64 KB')
  }
  if (typeof senha !== 'string') return fail('VALIDATION_FAILED', 'senha ausente')

  const bytes = new Uint8Array(await pfx.arrayBuffer())
  const leitura = lerCertificadoA1(bytes, senha)
  const now = (deps.now ?? (() => new Date()))()

  // Sem A1 utilizável, a função só autoriza e conta a tentativa (PFX nulo).
  let localFailure: ErrorCode | null = null
  if (!leitura.ok) localFailure = leitura.motivo === 'SENHA_INVALIDA' ? 'CERT_SENHA_INVALIDA' : 'VALIDATION_FAILED'
  else if (leitura.notAfter.getTime() <= now.getTime()) localFailure = 'CERT_VENCIDO'

  const send = leitura.ok && !localFailure
  const { rows } = await deps.db.query<{ result: DbResult }>(
    'select nofiscal.onboarding_set_certificate($1, $2, $3, $4, $5, $6) as result',
    [
      userId,
      tenantId,
      send ? Buffer.from(bytes).toString('base64') : null,
      send ? senha : null,
      send ? leitura.subject : null,
      send ? leitura.notAfter : null,
    ],
  )
  const dbResult = rows[0]?.result
  if (dbResult === 'FORBIDDEN') return result('upload', tenantId, 'FORBIDDEN')
  if (dbResult === 'RATE_LIMITED') return result('upload', tenantId, 'RATE_LIMITED')
  if (localFailure) {
    return localFailure === 'VALIDATION_FAILED'
      ? result('upload', tenantId, 'VALIDATION_FAILED', 'o arquivo não é um certificado A1 (.pfx/.p12) utilizável')
      : result('upload', tenantId, localFailure)
  }
  if (dbResult === 'CERT_VENCIDO' || dbResult === 'CERT_CNPJ_DIFERENTE') return result('upload', tenantId, dbResult)
  if (dbResult !== 'OK' || !leitura.ok) return result('upload', tenantId, 'VALIDATION_FAILED')

  logEvent('nofiscal.onboarding_certificate', { action: 'upload', tenant_id: tenantId, result: 'OK' })
  return json(201, { subject: leitura.subject, not_after: leitura.notAfter.toISOString() })
}

async function remove(request: Request, deps: OnboardingCertificateDeps): Promise<Response> {
  const userId = await deps.sessions.userIdFrom(request)
  if (!userId) return result('delete', null, 'UNAUTHORIZED')
  const tenantId = new URL(request.url).searchParams.get('tenant_id')
  if (!tenantId || !UUID.test(tenantId)) return fail('VALIDATION_FAILED', 'tenant_id inválido')

  const { rows } = await deps.db.query<{ result: DbResult }>(
    'select nofiscal.onboarding_delete_certificate($1, $2) as result',
    [userId, tenantId],
  )
  if (rows[0]?.result !== 'OK') return result('delete', tenantId, 'FORBIDDEN')
  logEvent('nofiscal.onboarding_certificate', { action: 'delete', tenant_id: tenantId, result: 'OK' })
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
}

function result(action: 'upload' | 'delete', tenantId: string | null, code: ErrorCode, message?: string): Response {
  logEvent('nofiscal.onboarding_certificate', { action, tenant_id: tenantId, result: code })
  return fail(code, message)
}
