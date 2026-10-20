// C4: ao ficar `issued`, o motor faz POST no `webhook_url` com HMAC-SHA256 do corpo bruto
// usando o segredo do tenant. Header e corpo: Unresolved 13 da tarefa ("Until answered").
import { createHmac } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import {
  createTestTenant,
  dropTestTenant,
  insertQueuedInvoice,
  openTestDb,
  readInvoice,
  sefinDouble,
  type TestTenant,
} from '../_tests/fixtures.js'
import { sendInvoiceCallback, type FetchLike } from './callback.js'
import { runEmission } from './emission.js'

const { db, pool } = openTestDb()
const tenants: TestTenant[] = []

afterAll(async () => {
  for (const t of tenants) await dropTestTenant(db, t.id)
  await pool.end()
})

type Received = { url: string; method: string; headers: Record<string, string>; body: string }

function recordingFetch(statuses: number[] = [200]): { fetch: FetchLike; received: Received[] } {
  const received: Received[] = []
  const fetch: FetchLike = async (url, init) => {
    received.push({ url, method: init.method, headers: init.headers, body: init.body })
    const status = statuses[Math.min(received.length - 1, statuses.length - 1)]
    return { ok: status >= 200 && status < 300, status }
  }
  return { fetch, received }
}

describe('callback ao cliente', () => {
  it('assina com HMAC', async () => {
    const t = await createTestTenant(db, {
      webhookUrl: 'https://prontia.example/functions/v1/nfse-callback',
      withWebhookSecret: true,
    })
    tenants.push(t)
    const invoice = await insertQueuedInvoice(db, t.id)
    const { fetch, received } = recordingFetch()

    await runEmission({
      db,
      sefin: sefinDouble().client,
      now: () => new Date(),
      tenantId: t.id,
      onFinal: async (id) => {
        await sendInvoiceCallback({ db, fetch, sleep: async () => undefined }, id)
      },
    })

    const row = await readInvoice(db, invoice.id)
    expect(row.status).toBe('issued')
    expect(received).toHaveLength(1)
    const call = received[0]
    expect(call.url).toBe('https://prontia.example/functions/v1/nfse-callback')
    expect(call.method).toBe('POST')

    const expected = `sha256=${createHmac('sha256', t.webhookSecret!).update(call.body, 'utf8').digest('hex')}`
    expect(call.headers['x-nofiscal-signature']).toBe(expected)
    expect(call.headers['content-type']).toBe('application/json')

    expect(JSON.parse(call.body)).toEqual({
      id: invoice.id,
      external_id: invoice.externalId,
      status: 'issued',
      chave_acesso: row.chave_acesso,
      last_error_code: null,
    })

    // Outro segredo não produz a mesma assinatura.
    const forged = `sha256=${createHmac('sha256', 'outro-segredo').update(call.body, 'utf8').digest('hex')}`
    expect(call.headers['x-nofiscal-signature']).not.toBe(forged)
  })

  it('reenvia até 5 vezes quando o cliente não responde 2xx', async () => {
    const t = await createTestTenant(db, { webhookUrl: 'https://prontia.example/cb', withWebhookSecret: true })
    tenants.push(t)
    const invoice = await insertQueuedInvoice(db, t.id)
    const { fetch, received } = recordingFetch([502])
    const result = await sendInvoiceCallback({ db, fetch, sleep: async () => undefined }, invoice.id)
    expect(result).toEqual({ delivered: false, reason: 'GAVE_UP', attempts: 6 })
    expect(received).toHaveLength(6)
    expect(new Set(received.map((r) => r.headers['x-nofiscal-signature'])).size).toBe(1)
  })

  it('sem webhook_url não envia nada', async () => {
    const t = await createTestTenant(db, { webhookUrl: null })
    tenants.push(t)
    const invoice = await insertQueuedInvoice(db, t.id)
    const { fetch, received } = recordingFetch()
    expect(await sendInvoiceCallback({ db, fetch }, invoice.id)).toMatchObject({ delivered: false, reason: 'NO_WEBHOOK_URL' })
    expect(received).toHaveLength(0)
  })
})
