// C24: certificado com `not_after` a 30 dias ou menos entra no alerta.
import { afterAll, describe, expect, it } from 'vitest'
import { createTestTenant, dropTestTenant, openTestDb, type TestTenant } from '../_tests/fixtures.js'
import { findExpiringCertificates, isInAlertWindow } from './cert-expiry.js'

const DAY = 24 * 60 * 60 * 1000
const { db, pool } = openTestDb()
const tenants: TestTenant[] = []

afterAll(async () => {
  for (const t of tenants) await dropTestTenant(db, t.id)
  await pool.end()
})

describe('alerta de vencimento do A1', () => {
  it('30 dias', async () => {
    const now = new Date('2026-11-03T12:00:00Z')
    expect(isInAlertWindow(new Date(now.getTime() + 30 * DAY), now)).toBe(true)
    expect(isInAlertWindow(new Date(now.getTime() + 29 * DAY), now)).toBe(true)
    expect(isInAlertWindow(new Date(now.getTime() - DAY), now)).toBe(true)
    expect(isInAlertWindow(new Date(now.getTime() + 30 * DAY + 60_000), now)).toBe(false)
    expect(isInAlertWindow(new Date(now.getTime() + 31 * DAY), now)).toBe(false)

    const real = new Date()
    const exactly30 = await createTestTenant(db, { notAfter: new Date(real.getTime() + 30 * DAY) })
    const in31 = await createTestTenant(db, { notAfter: new Date(real.getTime() + 31 * DAY) })
    const expired = await createTestTenant(db, { notAfter: new Date(real.getTime() - DAY) })
    tenants.push(exactly30, in31, expired)

    const found = new Map<string, boolean>()
    for (const t of [exactly30, in31, expired]) {
      const rows = await findExpiringCertificates(db, real, { tenantId: t.id })
      found.set(t.id, rows.length === 1)
      if (rows.length === 1) expect(rows[0].cnpj).toBe(t.cnpj)
    }
    expect(found.get(exactly30.id)).toBe(true)
    expect(found.get(in31.id)).toBe(false)
    expect(found.get(expired.id)).toBe(true)
    expect((await findExpiringCertificates(db, real, { tenantId: expired.id }))[0].expired).toBe(true)
  })
})
