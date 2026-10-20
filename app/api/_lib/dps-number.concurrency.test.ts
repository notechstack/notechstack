// C15: duas alocações concorrentes, em duas conexões, devolvem números distintos.
// Contra o banco local; cada conexão segura a sua transação aberta, como a emissão faz.
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestTenant, dropTestTenant, openTestDb, TEST_DATABASE_URL, type TestTenant } from '../_tests/fixtures.js'
import type { Queryable } from './db.js'
import { allocateDpsNumber, SerieNotFoundError } from './dps-number.js'

const { db, pool } = openTestDb()
let t: TestTenant

const asQueryable = (client: pg.Client): Queryable => ({
  async query<R>(text: string, values?: unknown[]) {
    const result = await client.query(text, values)
    return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 }
  },
})

beforeAll(async () => {
  t = await createTestTenant(db, { nextNumber: 500 })
})

afterAll(async () => {
  await dropTestTenant(db, t.id)
  await pool.end()
})

describe('numeração da DPS', () => {
  it('duas alocações concorrentes em duas conexões devolvem números distintos', async () => {
    const first = new pg.Client({ connectionString: TEST_DATABASE_URL })
    const second = new pg.Client({ connectionString: TEST_DATABASE_URL })
    await first.connect()
    await second.connect()
    try {
      await first.query('begin')
      await second.query('begin')
      const n1 = await allocateDpsNumber(asQueryable(first), t.id, '1')

      // A segunda alocação fica presa na linha da série até a primeira transação terminar.
      let settled = false
      const pending = allocateDpsNumber(asQueryable(second), t.id, '1').then((n) => {
        settled = true
        return n
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(settled).toBe(false)

      await first.query('commit')
      const n2 = await pending
      await second.query('commit')

      expect(n1).toBe(500)
      expect(n2).toBe(501)
      expect(n2).not.toBe(n1)
    } finally {
      await first.end()
      await second.end()
    }
  })

  it('rollback devolve o número para a próxima emissão', async () => {
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL })
    await client.connect()
    try {
      await client.query('begin')
      const discarded = await allocateDpsNumber(asQueryable(client), t.id, '1')
      await client.query('rollback')
      const next = await db.transaction((tx) => allocateDpsNumber(tx, t.id, '1'))
      expect(next).toBe(discarded)
    } finally {
      await client.end()
    }
  })

  it('série inexistente falha com NOFISCAL_SERIE_NOT_FOUND', async () => {
    await expect(db.transaction((tx) => allocateDpsNumber(tx, t.id, 'nao-existe'))).rejects.toBeInstanceOf(
      SerieNotFoundError,
    )
  })
})
