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
  // Rota da procuração do cadastro (migração 20261111180000).
  | 'PROCURADOR_INDISPONIVEL'
  | 'VALIDADE_PASSADA'
  // Emissão pelo painel "Minha conta" (painel-emissao.ts).
  | 'CONTA_SEM_EMPRESA'
  | 'SO_ESCRITORIO'
  | 'NFE_NAO_CONTRATADA'
  | 'EMISSAO_BLOQUEADA'
  | 'PLANILHA_RECUSADA'
  | 'LOTE_FECHADO'
  // API do parceiro (18/11/2026): empresas da conta, NF-e e cadastro pela API.
  | 'EMPRESA_NAO_ENCONTRADA'
  | 'EMPRESA_INATIVA'
  | 'CNPJ_JA_CADASTRADO'
  | 'EMPRESAS_ACIMA_DO_LIMITE'
  | 'CNPJ_NAO_ENCONTRADO'
  | 'CNPJ_INATIVO'
  | 'FORA_DO_SIMPLES'
  | 'RECEITA_INDISPONIVEL'
  | 'PROCURACAO_RECUSADA'
  | 'NFE_NAO_CANCELAVEL'
  // Sandbox da API do parceiro (19/11/2026).
  | 'SO_SANDBOX'
  | 'SANDBOX_SOMENTE_LEITURA'
  | 'SANDBOX_SEM_NFE'
  // Módulo Guias (20261119180000_agente_fiscal_guias.sql).
  | 'GUIAS_DESLIGADO'
  | 'STORAGE_NAO_CONFIGURADO'
  | 'GUIAS_BLOQUEADO'

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
  PROCURADOR_INDISPONIVEL: 409,
  VALIDADE_PASSADA: 422,
  CONTA_SEM_EMPRESA: 404,
  SO_ESCRITORIO: 403,
  NFE_NAO_CONTRATADA: 403,
  EMISSAO_BLOQUEADA: 409,
  PLANILHA_RECUSADA: 422,
  LOTE_FECHADO: 409,
  EMPRESA_NAO_ENCONTRADA: 404,
  EMPRESA_INATIVA: 409,
  CNPJ_JA_CADASTRADO: 409,
  EMPRESAS_ACIMA_DO_LIMITE: 409,
  CNPJ_NAO_ENCONTRADO: 422,
  CNPJ_INATIVO: 422,
  FORA_DO_SIMPLES: 422,
  RECEITA_INDISPONIVEL: 503,
  PROCURACAO_RECUSADA: 409,
  NFE_NAO_CANCELAVEL: 409,
  SO_SANDBOX: 403,
  SANDBOX_SOMENTE_LEITURA: 403,
  SANDBOX_SEM_NFE: 501,
  GUIAS_DESLIGADO: 403,
  STORAGE_NAO_CONFIGURADO: 503,
  GUIAS_BLOQUEADO: 409,
}

const NO_STORE = { 'cache-control': 'no-store' }

export function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: NO_STORE })
}

/** `extra` vai ao lado de `error` (ex.: o campo do formulário), nunca dentro dele. */
export function errorResponse(code: ErrorCode, message: string, extra: Record<string, unknown> = {}): Response {
  return json(STATUS_BY_CODE[code], { ...extra, error: { code, message } })
}
