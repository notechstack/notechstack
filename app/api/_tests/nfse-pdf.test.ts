// C9 (critério 6): GET /v1/nfse/:id/pdf de nota issued devolve 200 application/pdf no layout
// da NT 008/2026 (v1.02, referência §6). Chamada pela função exportada em api/v1/nfse.ts, com a
// nota emitida pelo motor com o cliente Sefin real e o transporte em dublê.
import { PDFDocument, PDFName } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeSharedDb } from '../_lib/db.js'
import { runEmission } from '../_lib/emission.js'
import { createSefinClient } from '../_lib/sefin-client.js'
import { sharedTestCertificate } from './certs.js'
import { createTestTenant, dropTestTenant, insertQueuedInvoice, openTestDb, readInvoice, TEST_DATABASE_URL, type TestTenant } from './fixtures.js'
import { pdfStreams, pdfTexts } from './pdf-text.js'
import { fakeSefin } from './sefin-fake.js'

process.env.NOFISCAL_DATABASE_URL = TEST_DATABASE_URL
const { default: entry } = await import('../v1/nfse.js')

const CM = 72 / 2.54
const { db, pool } = openTestDb()
const tenants: TestTenant[] = []
let t: TestTenant

beforeAll(async () => {
  t = await createTestTenant(db, { certificado: sharedTestCertificate().certificado })
  tenants.push(t)
})

afterAll(async () => {
  for (const x of tenants) await dropTestTenant(db, x.id)
  await pool.end()
  await closeSharedDb()
})

async function issued() {
  const invoice = await insertQueuedInvoice(db, t.id)
  const sefin = fakeSefin()
  await runEmission({ db, sefin: createSefinClient({ transport: sefin.transport }), now: () => new Date(), tenantId: t.id })
  const row = await readInvoice(db, invoice.id)
  expect(row.status).toBe('issued')
  return row
}

const getPdf = (id: string) =>
  entry.fetch(new Request(`https://app.notechstack.com.br/api/v1/nfse/${id}/pdf`, { headers: { 'x-api-key': t.apiKey } }))

describe('GET /v1/nfse/:id/pdf', () => {
  it('devolve PDF', async () => {
    const row = await issued()
    const res = await getPdf(row.id)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(Buffer.from(bytes.subarray(0, 5)).toString('latin1')).toBe('%PDF-')

    // NT 008 §2.2: página única, A4 retrato.
    const pdf = await PDFDocument.load(bytes)
    expect(pdf.getPageCount()).toBe(1)
    const { width, height } = pdf.getPage(0).getSize()
    expect(width).toBeCloseTo(595.28, 1)
    expect(height).toBeCloseTo(841.89, 1)

    // Cabeçalho (§2.4.3) e conteúdo vindo do XML da NFS-e (§2.1).
    const texts = pdfTexts(bytes)
    const all = texts.join('\n')
    expect(texts).toContain('DANFSe v2.0')
    expect(texts).toContain('Documento Auxiliar da NFS-e')
    expect(texts).toContain('NFS-e SEM VALIDADE JURÍDICA') // produção restrita (tpAmb 2)
    expect(texts).toContain(row.chave_acesso)
    expect(texts).toContain('123.456.789-09') // CPF do tomador
    expect(texts).toContain('Paciente de Teste')
    expect(texts).toContain('R$ 42,90')
    expect(texts).toContain('Prestador do serviço')
    for (const title of [
      'CHAVE DE ACESSO DA NFS-E E IDENTIFICAÇÃO',
      'PRESTADOR / FORNECEDOR',
      'TOMADOR / ADQUIRENTE',
      'SERVIÇO PRESTADO',
      'TRIBUTAÇÃO MUNICIPAL (ISSQN)',
      'VALOR TOTAL DA NFS-E',
      'INFORMAÇÕES COMPLEMENTARES',
    ]) {
      expect(texts, title).toContain(title)
    }
    expect(all).toContain('Lei 12.741/2012')
    expect(all).toContain('A autenticidade desta NFS-e pode ser verificada')
    expect(all).not.toContain('CANCELADA')

    // QR Code (§2.4.3): link da consulta pública com a chave, em X 17,48 cm, Y 1,67 cm, 1,52 cm.
    const annots = pdf.getPage(0).node.Annots()
    expect(annots?.size()).toBe(1)
    const link = pdf.context.lookup(annots!.get(0)) as unknown as { get(name: PDFName): unknown }
    const action = pdf.context.lookup(link.get(PDFName.of('A')) as never) as unknown as { get(name: PDFName): { decodeText(): string } }
    expect(action.get(PDFName.of('URI')).decodeText()).toBe(`https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=${row.chave_acesso}`)
    const rect = (pdf.context.lookup(link.get(PDFName.of('Rect')) as never) as unknown as { asRectangle(): { x: number; y: number; width: number; height: number } }).asRectangle()
    expect(rect.x).toBeCloseTo(17.48 * CM, 1)
    expect(height - (rect.y + rect.height)).toBeCloseTo(1.67 * CM, 1)
    expect(rect.width).toBeGreaterThanOrEqual(1.52 * CM - 0.01)
    expect(rect.height).toBeGreaterThanOrEqual(1.52 * CM - 0.01)
    // Os módulos do QR Code são desenhados em vetor: centenas de retângulos preenchidos (`f`).
    const fills = (s: string) => s.split('\n').filter((line) => line === 'f').length
    expect(pdfStreams(bytes).some((s) => fills(s) > 100)).toBe(true)
  })

  it('nota cancelada sai com a marca d’água CANCELADA', async () => {
    const row = await issued()
    await db.query(`update nofiscal.fiscal_invoices set status = 'cancelled', cancelled_at = now() where id = $1`, [row.id])
    const res = await getPdf(row.id)
    expect(res.status).toBe(200)
    const texts = pdfTexts(new Uint8Array(await res.arrayBuffer()))
    expect(texts).toContain('CANCELADA')
    expect(texts).toContain('Cancelada')
  })

  it('nota rejeitada ou em fila: 409', async () => {
    const invoice = await insertQueuedInvoice(db, t.id)
    expect((await getPdf(invoice.id)).status).toBe(409)
    await db.query(`update nofiscal.fiscal_invoices set status = 'rejected' where id = $1`, [invoice.id])
    const res = await getPdf(invoice.id)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_ISSUED')
  })
})
