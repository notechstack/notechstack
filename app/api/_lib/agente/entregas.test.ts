// Destinatários das entregas por e-mail. Check C5 de .checks/agente-fiscal-whatsapp.md.
// O código sob teste conecta como `nofiscal_service`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  allowTestUserToAssume,
  canaisDouble,
  createSelfServiceTenant,
  dropSelfServiceTenant,
  openRoleDb,
  type SelfServiceTenant,
} from '../../_tests/agente-fixtures.js'
import { openTestDb } from '../../_tests/fixtures.js'
import { definirContador } from './cadastro.js'
import { destinatariosDoEmail } from './entregas.js'

const admin = openTestDb()
const servico = openRoleDb('nofiscal_service')
const tenants: SelfServiceTenant[] = []

beforeAll(async () => {
  await allowTestUserToAssume(admin.db, 'nofiscal_service')
  const { rows } = await servico.db.query<{ papel: string }>('select current_user as papel')
  expect(rows[0].papel).toBe('nofiscal_service')
})

afterAll(async () => {
  for (const s of tenants) await dropSelfServiceTenant(admin.db, s)
  await servico.pool.end()
  await admin.pool.end()
})

describe('destinatários do e-mail', () => {
  it('contador recebe no Pro', async () => {
    const pro = await createSelfServiceTenant(admin.db, { plan: 'pro' })
    const inicial = await createSelfServiceTenant(admin.db, { plan: 'inicial' })
    tenants.push(pro, inicial)
    const canais = canaisDouble()
    const deps = { db: servico.db, email: canais.email, whatsapp: canais.whatsapp }

    // Antes de o contador ser informado, só dono e tomador.
    expect(await destinatariosDoEmail(servico.db, pro.tenant.id, { tomadorEmail: 'tomador@example.test' })).toEqual([
      { papel: 'dono', email: pro.ownerEmail },
      { papel: 'tomador', email: 'tomador@example.test' },
    ])

    expect(
      await definirContador(deps, { userId: pro.ownerUserId, tenantId: pro.tenant.id, email: ' Contador@Example.TEST ' }),
    ).toEqual({ ok: true })
    const { rows } = await admin.db.query<{ contador_email: string }>(
      'select contador_email from nofiscal.fiscal_tenants where id = $1',
      [pro.tenant.id],
    )
    expect(rows[0].contador_email).toBe('contador@example.test')

    expect(await destinatariosDoEmail(servico.db, pro.tenant.id, { tomadorEmail: 'tomador@example.test' })).toEqual([
      { papel: 'dono', email: pro.ownerEmail },
      { papel: 'tomador', email: 'tomador@example.test' },
      { papel: 'contador', email: 'contador@example.test' },
    ])
    expect(await destinatariosDoEmail(servico.db, pro.tenant.id, {})).toEqual([
      { papel: 'dono', email: pro.ownerEmail },
      { papel: 'contador', email: 'contador@example.test' },
    ])

    // No Inicial o contador gravado não recebe, nem o tomador.
    expect(
      await definirContador(deps, { userId: inicial.ownerUserId, tenantId: inicial.tenant.id, email: 'contador@example.test' }),
    ).toEqual({ ok: true })
    expect(await destinatariosDoEmail(servico.db, inicial.tenant.id, { tomadorEmail: 'tomador@example.test' })).toEqual([
      { papel: 'dono', email: inicial.ownerEmail },
    ])

    // Só o dono do tenant grava o contador, e só um e-mail.
    expect(
      await definirContador(deps, { userId: inicial.ownerUserId, tenantId: pro.tenant.id, email: 'outro@example.test' }),
    ).toEqual({ ok: false, erro: 'FORBIDDEN' })
    expect(await definirContador(deps, { userId: pro.ownerUserId, tenantId: pro.tenant.id, email: 'sem-arroba' })).toEqual({
      ok: false,
      erro: 'EMAIL_INVALIDO',
    })
    const { rows: depois } = await admin.db.query<{ contador_email: string }>(
      'select contador_email from nofiscal.fiscal_tenants where id = $1',
      [pro.tenant.id],
    )
    expect(depois[0].contador_email).toBe('contador@example.test')
  })
})
