// Cancelamento contra o banco local, com o cliente Sefin real e o transporte em dublê.
// Checks: C27 (lado do motor), C28, C29 (.checks/nfse-automatica-prontia.md).
import { afterAll, describe, expect, it } from 'vitest'
import { sharedTestCertificate } from '../_tests/certs.js'
import { createTestTenant, dropTestTenant, insertQueuedInvoice, minutes, openTestDb, readInvoice, type TestTenant } from '../_tests/fixtures.js'
import { fakeSefin } from '../_tests/sefin-fake.js'
import { verifySignature } from '../_tests/verify-signature.js'
import { runCancellations } from './cancel.js'
import { closeSharedDb } from './db.js'
import { runEmission } from './emission.js'
import { handleNfseRequest } from './nfse-routes.js'
import { createSefinClient } from './sefin-client.js'
import { handleWorkerRequest } from './worker-route.js'

const { db, pool } = openTestDb()
const tenants: TestTenant[] = []
const cert = sharedTestCertificate()

afterAll(async () => {
  for (const t of tenants) await dropTestTenant(db, t.id)
  await pool.end()
  await closeSharedDb()
})

async function tenant(options: Parameters<typeof createTestTenant>[1] = {}) {
  const created = await createTestTenant(db, { certificado: cert.certificado, ...options })
  tenants.push(created)
  return created
}

const cancel = (t: TestTenant, id: string) =>
  handleNfseRequest(
    new Request(`https://app.notechstack.com.br/api/v1/nfse/${id}/cancel`, { method: 'POST', headers: { 'x-api-key': t.apiKey } }),
    { db },
  )

type EventRow = { tipo: string; status: string; xml: string | null; last_error_code: string | null }
const events = async (invoiceId: string) =>
  (
    await db.query<EventRow>(
      'select tipo, status, xml, last_error_code from nofiscal.fiscal_invoice_events where invoice_id = $1 order by created_at',
      [invoiceId],
    )
  ).rows

/** Nota emitida pelo motor com o cliente real, pronta para cancelar. */
async function issuedInvoice(sefin: ReturnType<typeof fakeSefin>, t: TestTenant, at: Date) {
  const invoice = await insertQueuedInvoice(db, t.id)
  await runEmission({ db, sefin: createSefinClient({ transport: sefin.transport }), now: () => at, tenantId: t.id })
  const row = await readInvoice(db, invoice.id)
  expect(row.status).toBe('issued')
  return row
}

const cancellationRequests = (sefin: ReturnType<typeof fakeSefin>) => sefin.requests.filter((r) => r.path.includes('/eventos'))

describe('cancelamento de nota emitida (C27)', () => {
  it('e101101 chega a cancelled', async () => {
    const t0 = new Date()
    const t = await tenant()
    const sefin = fakeSefin()
    const row = await issuedInvoice(sefin, t, t0)

    const res = await cancel(t, row.id)
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ id: row.id, status: 'cancel_requested' })
    expect((await readInvoice(db, row.id)).status).toBe('cancel_requested')

    const statusDuringTransmission: string[] = []
    const client = createSefinClient({
      transport: async (request, tls) => {
        statusDuringTransmission.push((await readInvoice(db, row.id)).status)
        return sefin.transport(request, tls)
      },
    })
    const t1 = minutes(t0, 1)
    const summary = await runCancellations({ db, sefin: client, now: () => t1, tenantId: t.id })
    expect(summary).toMatchObject({ claimed: 1, cancelled: 1 })

    // O motor transmitiu o evento e101101 da chave da nota, assinado.
    const sent = cancellationRequests(sefin)
    expect(sent).toHaveLength(1)
    expect(sent[0].method).toBe('POST')
    expect(sent[0].path).toBe(`/nfse/${row.chave_acesso}/eventos`)
    expect(sent[0].xml).toContain(`<infPedReg Id="PRE${row.chave_acesso}101101">`)
    expect(sent[0].xml).toContain('<e101101>')
    expect(verifySignature(sent[0].xml!, cert.certPem)).toBe(true)
    expect(statusDuringTransmission).toEqual(['cancel_requested'])

    const after = await readInvoice(db, row.id)
    expect(after.status).toBe('cancelled')
    const { rows } = await db.query<{ cancelled_at: Date | null }>('select cancelled_at from nofiscal.fiscal_invoices where id = $1', [row.id])
    expect(rows[0].cancelled_at).toEqual(t1)

    // Registrado em fiscal_invoice_events (critério 19), com o XML do evento devolvido.
    const recorded = await events(row.id)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ tipo: 'e101101', status: 'accepted', last_error_code: null })
    expect(recorded[0].xml).toContain('<infEvento')

    // Pedido repetido não retransmite e devolve o estado atual.
    const again = await cancel(t, row.id)
    expect(await again.json()).toEqual({ id: row.id, status: 'cancelled' })
    await runCancellations({ db, sefin: client, now: () => minutes(t0, 500), tenantId: t.id })
    expect(cancellationRequests(sefin)).toHaveLength(1)
  })

  it('Sefin fora: retenta com espera e consulta o evento antes de retransmitir', async () => {
    const t0 = new Date()
    const t = await tenant()
    let down = true
    const sefin = fakeSefin({ evento: () => (down ? { status: 503, body: 'indisponível' } : undefined) })
    const row = await issuedInvoice(sefin, t, t0)
    await cancel(t, row.id)
    const client = createSefinClient({ transport: sefin.transport })

    await runCancellations({ db, sefin: client, now: () => t0, tenantId: t.id })
    let current = await readInvoice(db, row.id)
    expect(current.status).toBe('cancel_requested')
    expect(current.last_error_code).toBe('SEFIN_UNAVAILABLE')

    // Antes da espera de 1 min, nada sai.
    await runCancellations({ db, sefin: client, now: () => minutes(t0, 0.5), tenantId: t.id })
    expect(cancellationRequests(sefin).filter((r) => r.method === 'POST')).toHaveLength(1)

    down = false
    await runCancellations({ db, sefin: client, now: () => minutes(t0, 6), tenantId: t.id })
    const paths = cancellationRequests(sefin).map((r) => `${r.method} ${r.path.replace(row.chave_acesso!, '{chave}')}`)
    expect(paths).toEqual(['POST /nfse/{chave}/eventos', 'GET /nfse/{chave}/eventos/101101/1', 'POST /nfse/{chave}/eventos'])
    current = await readInvoice(db, row.id)
    expect(current.status).toBe('cancelled')
    expect((await events(row.id)).map((e) => e.status)).toEqual(['sent', 'accepted'])
  })

  it('a consulta acha o evento já registrado e não retransmite', async () => {
    const t0 = new Date()
    const t = await tenant()
    let lose = true
    const sefin = fakeSefin()
    const row = await issuedInvoice(sefin, t, t0)
    await cancel(t, row.id)
    // O 1º envio chega à Sefin, mas a resposta se perde.
    const client = createSefinClient({
      transport: async (request, tls) => {
        const response = await sefin.transport(request, tls)
        if (lose && request.method === 'POST' && request.url.endsWith('/eventos')) {
          lose = false
          throw new Error('socket hang up')
        }
        return response
      },
    })
    await runCancellations({ db, sefin: client, now: () => t0, tenantId: t.id })
    expect((await readInvoice(db, row.id)).status).toBe('cancel_requested')
    await runCancellations({ db, sefin: client, now: () => minutes(t0, 2), tenantId: t.id })
    expect(cancellationRequests(sefin).filter((r) => r.method === 'POST')).toHaveLength(1)
    expect((await readInvoice(db, row.id)).status).toBe('cancelled')
  })
})

describe('cancelamento antes de transmitir (C28)', () => {
  it('queued vira skipped', async () => {
    const t0 = new Date()
    const t = await tenant()
    const invoice = await insertQueuedInvoice(db, t.id)
    const sefin = fakeSefin()

    const res = await cancel(t, invoice.id)
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ id: invoice.id, status: 'skipped' })

    const client = createSefinClient({ transport: sefin.transport })
    await runEmission({ db, sefin: client, now: () => minutes(t0, 1), tenantId: t.id })
    await runCancellations({ db, sefin: client, now: () => minutes(t0, 1), tenantId: t.id })

    expect(sefin.requests).toHaveLength(0)
    const row = await readInvoice(db, invoice.id)
    expect(row.status).toBe('skipped')
    expect(row.dps_numero).toBeNull()
    expect(await events(invoice.id)).toHaveLength(0)
  })

  it('nota em voo (sent) volta como está, sem efeito', async () => {
    const t0 = new Date()
    const t = await tenant()
    const invoice = await insertQueuedInvoice(db, t.id)
    const sefin = fakeSefin({ emitir: () => ({ status: 503, body: '' }) })
    await runEmission({ db, sefin: createSefinClient({ transport: sefin.transport }), now: () => t0, tenantId: t.id })
    expect((await readInvoice(db, invoice.id)).status).toBe('sent')
    const res = await cancel(t, invoice.id)
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ id: invoice.id, status: 'sent' })
    expect((await readInvoice(db, invoice.id)).status).toBe('sent')
  })
})

describe('recusa do cancelamento (C29)', () => {
  it('recusa mantém cancel_requested', async () => {
    const t0 = new Date()
    const t = await tenant()
    const sefin = fakeSefin({
      evento: () => ({
        status: 400,
        body: JSON.stringify({ erro: [{ codigo: 'E0822', descricao: 'Cancelamento fora do prazo do município' }] }),
      }),
    })
    const row = await issuedInvoice(sefin, t, t0)
    await cancel(t, row.id)
    const client = createSefinClient({ transport: sefin.transport })

    const summary = await runCancellations({ db, sefin: client, now: () => t0, tenantId: t.id })
    expect(summary).toMatchObject({ claimed: 1, refused: 1 })

    const after = await readInvoice(db, row.id)
    expect(after.status).toBe('cancel_requested')
    expect(after.last_error_code).toBe('E0822')
    expect(after.last_error).toContain('fora do prazo')
    expect(await events(row.id)).toEqual([expect.objectContaining({ tipo: 'e101101', status: 'refused', last_error_code: 'E0822' })])

    // Pendência para o contador: não é retransmitida, nem com novo pedido.
    const again = await cancel(t, row.id)
    expect(await again.json()).toEqual({ id: row.id, status: 'cancel_requested' })
    await runCancellations({ db, sefin: client, now: () => minutes(t0, 600), tenantId: t.id })
    expect(cancellationRequests(sefin)).toHaveLength(1)
    expect((await readInvoice(db, row.id)).last_error_code).toBe('E0822')
  })
})

describe('worker', () => {
  it('emite, cancela e avisa o cliente pelo callback', async () => {
    const t0 = new Date()
    const t = await tenant({ webhookUrl: 'https://prontia.example/functions/v1/nfse-callback', withWebhookSecret: true })
    const invoice = await insertQueuedInvoice(db, t.id)
    const sefin = fakeSefin()
    const delivered: { status: string; last_error_code: string | null }[] = []
    const deps = {
      db,
      sefin: createSefinClient({ transport: sefin.transport }),
      cronSecret: 'segredo-do-cron',
      tenantId: t.id,
      fetch: async (_url: string, init: { body: string }) => {
        delivered.push(JSON.parse(init.body) as { status: string; last_error_code: string | null })
        return { ok: true, status: 200 }
      },
    }
    const call = (at: Date) =>
      handleWorkerRequest(
        new Request('https://app.notechstack.com.br/api/internal/nfse-worker', { headers: { authorization: 'Bearer segredo-do-cron' } }),
        { ...deps, now: () => at },
      )

    expect((await call(t0)).status).toBe(200)
    expect((await readInvoice(db, invoice.id)).status).toBe('issued')
    await cancel(t, invoice.id)
    const res = await call(minutes(t0, 1))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { cancellations: { cancelled: number } }).cancellations.cancelled).toBe(1)
    expect((await readInvoice(db, invoice.id)).status).toBe('cancelled')
    expect(delivered.map((d) => d.status)).toEqual(['issued', 'cancelled'])
  })
})
