// API pública, chamada pela função exportada em api/v1/nfse.ts com Request HTTP, contra o
// banco local. Checks: C2, C13, C32 (.checks/nfse-automatica-prontia.md).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeSharedDb } from '../_lib/db.js'
import { createTestTenant, dropTestTenant, openTestDb, TEST_DATABASE_URL, validPayload, type TestTenant } from './fixtures.js'

process.env.NOFISCAL_DATABASE_URL = TEST_DATABASE_URL
const { default: entry } = await import('../v1/nfse.js')

type ApiBody = { id: string; status: string; error: { code: string; message: string } } & Record<string, unknown>
const read = async (res: Response) => (await res.json()) as ApiBody

const BASE = 'https://app.notechstack.com.br/api'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const { db, pool } = openTestDb()
const tenants: TestTenant[] = []
let a: TestTenant
let b: TestTenant

const call = (path: string, init: { method?: string; key?: string | null; body?: unknown; rawBody?: string } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (init.key) headers['x-api-key'] = init.key
  return entry.fetch(
    new Request(`${BASE}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
    }),
  )
}

const newSale = (externalId: string) => ({ external_id: externalId, ...validPayload() })

beforeAll(async () => {
  a = await createTestTenant(db)
  b = await createTestTenant(db)
  tenants.push(a, b)
})

afterAll(async () => {
  for (const t of tenants) await dropTestTenant(db, t.id)
  await pool.end()
  await closeSharedDb()
})

describe('POST /v1/nfse', () => {
  it('202 queued', async () => {
    const res = await call('/v1/nfse', { method: 'POST', key: a.apiKey, body: newSale('venda-202') })
    expect(res.status).toBe(202)
    const body = await read(res)
    expect(body).toEqual({ id: expect.stringMatching(UUID), status: 'queued' })

    const { rows } = await db.query<{ tenant_id: string; external_id: string; status: string; payload: unknown }>(
      'select tenant_id, external_id, status, payload from nofiscal.fiscal_invoices where id = $1',
      [body.id],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ tenant_id: a.id, external_id: 'venda-202', status: 'queued' })
    expect(rows[0].payload).toEqual(validPayload())
  })

  it('idempotente por external_id', async () => {
    const first = await call('/v1/nfse', { method: 'POST', key: a.apiKey, body: newSale('venda-repetida') })
    const second = await call('/v1/nfse', {
      method: 'POST',
      key: a.apiKey,
      body: { ...newSale('venda-repetida'), valor: '99.00' },
    })
    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    const firstBody = await read(first)
    const secondBody = await read(second)
    expect(secondBody.id).toBe(firstBody.id)

    // Ao mesmo tempo (critério 8): as duas respostas trazem o mesmo id.
    const [c1, c2] = await Promise.all([
      call('/v1/nfse', { method: 'POST', key: a.apiKey, body: newSale('venda-simultanea') }),
      call('/v1/nfse', { method: 'POST', key: a.apiKey, body: newSale('venda-simultanea') }),
    ])
    const [b1, b2] = await Promise.all([read(c1), read(c2)])
    expect(c1.status).toBe(202)
    expect(c2.status).toBe(202)
    expect(b2.id).toBe(b1.id)

    const { rows } = await db.query<{ external_id: string; n: string }>(
      `select external_id, count(*) as n from nofiscal.fiscal_invoices
        where tenant_id = $1 and external_id in ('venda-repetida', 'venda-simultanea') group by external_id`,
      [a.id],
    )
    expect(Object.fromEntries(rows.map((r) => [r.external_id, Number(r.n)]))).toEqual({
      'venda-repetida': 1,
      'venda-simultanea': 1,
    })

    // O mesmo external_id em outro tenant é outra venda.
    const other = await call('/v1/nfse', { method: 'POST', key: b.apiKey, body: newSale('venda-repetida') })
    expect((await read(other)).id).not.toBe(firstBody.id)
  })

  it('recusa corpo inválido', async () => {
    const badJson = await call('/v1/nfse', { method: 'POST', key: a.apiKey, rawBody: '{nope' })
    expect(badJson.status).toBe(400)
    expect(await read(badJson)).toEqual({ error: { code: 'INVALID_JSON', message: expect.any(String) } })

    const badCpf = await call('/v1/nfse', {
      method: 'POST',
      key: a.apiKey,
      body: { ...newSale('cpf-ruim'), tomador: { cpf: '123', nome: 'X' } },
    })
    expect(badCpf.status).toBe(422)
    expect((await read(badCpf)).error.code).toBe('VALIDATION_FAILED')
  })
})

describe('autenticação e isolamento por tenant', () => {
  it('401 e 404', async () => {
    const created = await call('/v1/nfse', { method: 'POST', key: b.apiKey, body: newSale('venda-de-b') })
    const idB = (await read(created)).id as string

    for (const [path, method] of [
      ['/v1/nfse', 'POST'],
      [`/v1/nfse/${idB}`, 'GET'],
      [`/v1/nfse/${idB}/cancel`, 'POST'],
      [`/v1/nfse/${idB}/pdf`, 'GET'],
    ] as const) {
      const missing = await call(path, { method, key: null, body: method === 'POST' ? newSale('sem-chave') : undefined })
      expect(missing.status, `${method} ${path} sem chave`).toBe(401)
      expect((await read(missing)).error.code).toBe('UNAUTHORIZED')

      const invalid = await call(path, { method, key: 'nfk_chave-invalida', body: method === 'POST' ? newSale('chave-ruim') : undefined })
      expect(invalid.status, `${method} ${path} chave inválida`).toBe(401)
      expect((await read(invalid)).error.code).toBe('UNAUTHORIZED')
    }

    // Chave válida de A, nota de B: 404, nas três rotas por id e nas duas formas de URL.
    for (const [path, method] of [
      [`/v1/nfse/${idB}`, 'GET'],
      [`/v1/nfse/${idB}/cancel`, 'POST'],
      [`/v1/nfse/${idB}/pdf`, 'GET'],
      [`/v1/nfse?id=${idB}`, 'GET'],
      [`/v1/nfse?id=${idB}&acao=pdf`, 'GET'],
    ] as const) {
      const res = await call(path, { method, key: a.apiKey })
      expect(res.status, `${method} ${path} de outro tenant`).toBe(404)
      expect((await read(res)).error.code).toBe('NOT_FOUND')
    }

    const notUuid = await call('/v1/nfse/nao-e-uuid', { key: a.apiKey })
    expect(notUuid.status).toBe(404)

    // O dono da nota a enxerga.
    const own = await call(`/v1/nfse/${idB}`, { key: b.apiKey })
    expect(own.status).toBe(200)
    expect(await read(own)).toEqual({
      id: idB,
      external_id: 'venda-de-b',
      status: 'queued',
      chave_acesso: null,
      last_error_code: null,
    })
  })

  it('tenant inativo recebe 403', async () => {
    const inactive = await createTestTenant(db, { active: false })
    tenants.push(inactive)
    const res = await call('/v1/nfse', { method: 'POST', key: inactive.apiKey, body: newSale('inativo') })
    expect(res.status).toBe(403)
    expect((await read(res)).error.code).toBe('TENANT_INACTIVE')
  })

  it('PDF de nota ainda não emitida responde 409', async () => {
    const created = await call('/v1/nfse', { method: 'POST', key: a.apiKey, body: newSale('pdf-cedo') })
    const id = (await read(created)).id
    const res = await call(`/v1/nfse/${id}/pdf`, { key: a.apiKey })
    expect(res.status).toBe(409)
    expect((await read(res)).error.code).toBe('NOT_ISSUED')
  })
})
