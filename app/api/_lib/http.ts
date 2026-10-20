// Respostas da API do Nó Fiscal. Formato de erro: Unresolved 11 da tarefa
// (`{ "error": { "code", "message" } }`), forma literal no Landing do checklist.

export type ErrorCode =
  | 'INVALID_JSON'
  | 'UNAUTHORIZED'
  | 'TENANT_INACTIVE'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'NOT_ISSUED'
  | 'VALIDATION_FAILED'
  | 'UNKNOWN_FIELD'
  | 'INTERNAL'
  | 'SEFIN_NOT_CONFIGURED'
  // Rota do certificado do cadastro (Landing de .checks/agente-fiscal-whatsapp.md, lote A).
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'CERT_SENHA_INVALIDA'
  | 'CERT_VENCIDO'
  | 'CERT_CNPJ_DIFERENTE'

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  INVALID_JSON: 400,
  UNAUTHORIZED: 401,
  TENANT_INACTIVE: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  NOT_ISSUED: 409,
  VALIDATION_FAILED: 422,
  UNKNOWN_FIELD: 422,
  INTERNAL: 500,
  SEFIN_NOT_CONFIGURED: 503,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  CERT_SENHA_INVALIDA: 422,
  CERT_VENCIDO: 422,
  CERT_CNPJ_DIFERENTE: 422,
}

const NO_STORE = { 'cache-control': 'no-store' }

export function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: NO_STORE })
}

export function errorResponse(code: ErrorCode, message: string): Response {
  return json(STATUS_BY_CODE[code], { error: { code, message } })
}
