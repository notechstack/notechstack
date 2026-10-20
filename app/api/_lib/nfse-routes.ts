// Roteador das quatro rotas públicas (tabela Surface da tarefa), servidas por uma única
// função (`api/v1/nfse.ts`). O `vercel.json` reescreve `/api/v1/nfse/:id[/:acao]` para
// `/api/v1/nfse?id=…&acao=…`; o roteador entende as duas formas (Landing, lote 2a).
// O trabalho com a Sefin não roda aqui: o POST só enfileira e responde 202 (Unresolved 26).
import { findTenantByApiKey } from './auth.js'
import { requestCancel } from './cancel.js'
import type { Db } from './db.js'
import { errorResponse, json } from './http.js'
import { createOrGetInvoice, findInvoiceForTenant } from './invoices.js'
import { logEvent } from './log.js'
import { parseNewInvoice } from './validation.js'

export type NfseAction = 'cancel' | 'pdf'

export type NfseRoute = { kind: 'collection' } | { kind: 'item'; id: string; action: NfseAction | null }

const PREFIX = '/api/v1/nfse'
const ACTIONS: readonly string[] = ['cancel', 'pdf']

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

/** Todas as rotas que esta função atende; nenhuma recebe certificado (critério 31). */
export const NFSE_ROUTES = [
  { method: 'POST', path: '/v1/nfse' },
  { method: 'GET', path: '/v1/nfse/:id' },
  { method: 'POST', path: '/v1/nfse/:id/cancel' },
  { method: 'GET', path: '/v1/nfse/:id/pdf' },
] as const

export function parseNfseRoute(url: URL): NfseRoute | null {
  const path = url.pathname.replace(/\/+$/, '')
  if (path === PREFIX) {
    const id = url.searchParams.get('id')
    if (!id) return { kind: 'collection' }
    const action = url.searchParams.get('acao')
    if (action === null || action === '') return { kind: 'item', id, action: null }
    return ACTIONS.includes(action) ? { kind: 'item', id, action: action as NfseAction } : null
  }
  if (!path.startsWith(`${PREFIX}/`)) return null
  const parts = path.slice(PREFIX.length + 1).split('/')
  const id = parts[0] ? decode(parts[0]) : null
  if (!id) return null
  if (parts.length === 1) return { kind: 'item', id, action: null }
  if (parts.length === 2 && ACTIONS.includes(parts[1])) return { kind: 'item', id, action: parts[1] as NfseAction }
  return null
}

export type NfseDeps = { db: Db; now?: () => Date }

export async function handleNfseRequest(request: Request, deps: NfseDeps): Promise<Response> {
  try {
    return await route(request, deps)
  } catch (error) {
    logEvent('nofiscal.api_error', { error_name: error instanceof Error ? error.name : 'unknown' })
    return errorResponse('INTERNAL', 'erro interno')
  }
}

async function route(request: Request, { db, now = () => new Date() }: NfseDeps): Promise<Response> {
  const target = parseNfseRoute(new URL(request.url))
  if (!target) return errorResponse('NOT_FOUND', 'rota não encontrada')

  const tenant = await findTenantByApiKey(db, request.headers.get('x-api-key'))
  if (!tenant) return errorResponse('UNAUTHORIZED', 'x-api-key ausente ou inválida')
  // Tenant inativo: 403 (Unresolved 11 da tarefa, valor de "Until answered").
  if (!tenant.active) return errorResponse('TENANT_INACTIVE', 'tenant inativo')

  if (target.kind === 'collection') {
    if (request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'use POST')
    let body: unknown
    try {
      body = JSON.parse(await request.text())
    } catch {
      return errorResponse('INVALID_JSON', 'corpo não é JSON válido')
    }
    const parsed = parseNewInvoice(body)
    if (!parsed.ok) return errorResponse(parsed.code, parsed.message)
    const invoice = await createOrGetInvoice(db, tenant.id, parsed.value)
    return json(202, { id: invoice.id, status: invoice.status })
  }

  const invoice = await findInvoiceForTenant(db, tenant.id, target.id)
  if (!invoice) return errorResponse('NOT_FOUND', 'nota não encontrada')

  if (target.action === null) {
    if (request.method !== 'GET') return errorResponse('METHOD_NOT_ALLOWED', 'use GET')
    return json(200, invoice)
  }
  if (target.action === 'cancel') {
    if (request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'use POST')
    // Só registra o pedido; o evento e101101 sai pelo worker (Landing, lote 2b - cancelamento).
    const result = await requestCancel(db, tenant.id, invoice.id, now())
    if (!result) return errorResponse('NOT_FOUND', 'nota não encontrada')
    return json(202, { id: result.id, status: result.status })
  }
  if (request.method !== 'GET') return errorResponse('METHOD_NOT_ALLOWED', 'use GET')
  // Nota ainda não emitida: 409 (Unresolved 23 da tarefa, valor de "Until answered").
  if (invoice.status !== 'issued') return errorResponse('NOT_ISSUED', 'a nota ainda não foi emitida')
  // DANFSe no layout da NT 008/2026: lote 2b (C9).
  return errorResponse('NOT_IMPLEMENTED', 'DANFSe ainda não disponível')
}
