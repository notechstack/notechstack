// GET /api/v1/fiscal/nota-pdf?invoice_id=<uuid>: DANFSe da nota para baixar no painel do site (aba Relatórios
// de "Minha conta"; .design/agente-fiscal-escritorio.md, Decision "PDF da nota"). Sessão Supabase do site
// (Authorization: Bearer), posse por `nofiscal.usuario_pode_tenant` (dono direto ou escritório da empresa) e
// só nota com NFS-e (`issued` ou `cancelled`, `xml_nfse` gravado). O PDF é gerado a cada pedido e não fica
// guardado. Qualquer outro caso é 404, sem dizer se a nota existe.
import { renderDanfse, type DanfseOptions } from './danfse-renderer.js'
import type { Queryable } from './db.js'
import { errorResponse } from './http.js'
import { logEvent } from './log.js'
import { parseNfseXml } from './nfse-xml.js'
import type { SessionVerifier } from './session.js'

export type NotaPdfDeps = {
  /** Conexão como `nofiscal_service`. */
  db: Queryable
  sessions: SessionVerifier
  /** Troca o renderizador nos testes; o padrão é o DANFSe da NT 008. */
  render?: (xmlNfse: string, options?: DanfseOptions) => Promise<Uint8Array>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COM_PDF: readonly string[] = ['issued', 'cancelled']

type Linha = { status: string; xml_nfse: string | null; dps_numero: string | number | null; pode: boolean | null }

function naoEncontrada(invoiceId: string | null, motivo: string): Response {
  logEvent('nofiscal.nota_pdf', { invoice_id: invoiceId, result: 'NOT_FOUND', motivo })
  return errorResponse('NOT_FOUND', 'nota não encontrada')
}

/** Número para o nome do arquivo: o da NFS-e, senão o da DPS, senão o id. Só letras, números e hífen. */
export function nomeDoArquivo(nota: Pick<Linha, 'xml_nfse' | 'dps_numero'>, invoiceId: string): string {
  let numero: string | null = null
  if (nota.xml_nfse) {
    try {
      numero = parseNfseXml(nota.xml_nfse).nNFSe || null
    } catch {
      numero = null
    }
  }
  if (!numero && nota.dps_numero !== null && nota.dps_numero !== undefined) numero = String(nota.dps_numero)
  const limpo = (numero ?? '').replace(/[^0-9A-Za-z-]/g, '')
  return `nfse-${limpo || invoiceId}.pdf`
}

export async function handleNotaPdf(request: Request, deps: NotaPdfDeps): Promise<Response> {
  try {
    if (request.method !== 'GET') return errorResponse('METHOD_NOT_ALLOWED', 'use GET')
    const userId = await deps.sessions.userIdFrom(request)
    if (!userId) {
      logEvent('nofiscal.nota_pdf', { invoice_id: null, result: 'UNAUTHORIZED' })
      return errorResponse('UNAUTHORIZED', 'faça login para baixar a nota')
    }
    const invoiceId = new URL(request.url).searchParams.get('invoice_id')
    if (!invoiceId || !UUID.test(invoiceId)) return naoEncontrada(null, 'id')

    const { rows } = await deps.db.query<Linha>(
      `select i.status, i.xml_nfse, i.dps_numero, nofiscal.usuario_pode_tenant($1, i.tenant_id) as pode
         from nofiscal.fiscal_invoices i
        where i.id = $2`,
      [userId, invoiceId],
    )
    const nota = rows[0]
    if (!nota || nota.pode !== true) return naoEncontrada(invoiceId, 'posse')
    if (!COM_PDF.includes(nota.status) || !nota.xml_nfse) return naoEncontrada(invoiceId, 'sem_nfse')

    const render = deps.render ?? renderDanfse
    const pdf = await render(nota.xml_nfse, { cancelada: nota.status === 'cancelled' })
    logEvent('nofiscal.nota_pdf', { invoice_id: invoiceId, result: 'OK' })
    return new Response(Buffer.from(pdf), {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="${nomeDoArquivo(nota, invoiceId)}"`,
        'cache-control': 'no-store',
      },
    })
  } catch (error) {
    // Só o nome do erro: a mensagem de um driver ou do leitor de XML pode ecoar dados da nota.
    logEvent('nofiscal.nota_pdf_error', { error_name: error instanceof Error ? error.name : 'unknown' })
    return errorResponse('INTERNAL', 'erro interno')
  }
}
