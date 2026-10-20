// Resumo mensal do Pro no WhatsApp. Check C38 de .checks/agente-fiscal-whatsapp.md.
// O código sob teste conecta como `nofiscal_service`; o WhatsApp é um dublê.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  allowTestUserToAssume,
  canaisDouble,
  createSelfServiceTenant,
  dropSelfServiceTenant,
  LINKS_DE_TESTE,
  openRoleDb,
  type SelfServiceTenant,
} from '../../_tests/agente-fixtures.js'
import { openTestDb } from '../../_tests/fixtures.js'
import { enviarResumoMensal } from './resumo-mensal.js'

const admin = openTestDb()
const servico = openRoleDb('nofiscal_service')
const tenants: SelfServiceTenant[] = []

beforeAll(async () => {
  await allowTestUserToAssume(admin.db, 'nofiscal_service')
})

afterAll(async () => {
  for (const s of tenants) await dropSelfServiceTenant(admin.db, s)
  await servico.pool.end()
  await admin.pool.end()
})

async function nota(
  s: SelfServiceTenant,
  opcoes: { valor: string; emitidaEm: string; status?: 'issued' | 'cancelled'; canceladaEm?: string },
) {
  await admin.db.query(
    `insert into nofiscal.fiscal_invoices (tenant_id, external_id, payload, status, issued_at, cancelled_at)
     values ($1, $2, $3::jsonb, $4, $5, $6)`,
    [
      s.tenant.id,
      `resumo-${randomUUID()}`,
      JSON.stringify({ tomador: { cpf: '52998224725', nome: 'Tomador' }, servico: { codigo_servico_nacional: '010701', descricao: 'x' }, valor: opcoes.valor }),
      opcoes.status ?? 'issued',
      opcoes.emitidaEm,
      opcoes.canceladaEm ?? null,
    ],
  )
}

async function tenant(plan: 'inicial' | 'pro') {
  const s = await createSelfServiceTenant(admin.db, { plan })
  tenants.push(s)
  return s
}

describe('resumo mensal do Pro', () => {
  it('resumo do mês anterior', async () => {
    const pro = await tenant('pro')
    const proSemNotas = await tenant('pro')
    const inicial = await tenant('inicial')
    const proSoCancelada = await tenant('pro')

    // Outubro/2026 (horário de São Paulo, UTC-3).
    await nota(pro, { valor: '100.00', emitidaEm: '2026-10-05T12:00:00-03:00' })
    await nota(pro, { valor: '50.50', emitidaEm: '2026-10-31T23:30:00-03:00' })
    await nota(pro, { valor: '30.00', emitidaEm: '2026-10-12T10:00:00-03:00', status: 'cancelled', canceladaEm: '2026-10-13T10:00:00-03:00' })
    // Fora do mês: setembro e novembro.
    await nota(pro, { valor: '999.00', emitidaEm: '2026-09-30T23:59:00-03:00' })
    await nota(pro, { valor: '7.00', emitidaEm: '2026-11-01T00:10:00-03:00' })
    await nota(proSemNotas, { valor: '5.00', emitidaEm: '2026-09-15T10:00:00-03:00' })
    await nota(inicial, { valor: '80.00', emitidaEm: '2026-10-08T10:00:00-03:00' })
    // Emitida em setembro e cancelada em outubro: só conta como cancelada.
    await nota(proSoCancelada, { valor: '40.00', emitidaEm: '2026-09-28T10:00:00-03:00', status: 'cancelled', canceladaEm: '2026-10-02T10:00:00-03:00' })

    const canais = canaisDouble()
    const ids = [pro, proSemNotas, inicial, proSoCancelada].map((s) => s.tenant.id)
    const rodar = (instante: string) =>
      enviarResumoMensal(
        { db: servico.db, whatsapp: canais.whatsapp, email: canais.email, links: LINKS_DE_TESTE, now: () => new Date(instante) },
        { tenantIds: ids },
      )

    // Dia 1, antes das 09:00: nada.
    await rodar('2026-11-01T07:00:00-03:00')
    expect(canais.whatsapps).toHaveLength(0)

    await rodar('2026-11-01T09:30:00-03:00')
    expect(canais.whatsapps.map((m) => m.para).sort()).toEqual([pro.ownerPhone, proSoCancelada.ownerPhone].sort())

    const resumo = canais.whatsapps.find((m) => m.para === pro.ownerPhone)?.texto ?? ''
    expect(resumo).toContain('outubro/2026')
    expect(resumo).toMatch(/\b3 notas emitidas\b/)
    expect(resumo).toMatch(/\b1 cancelada\b/)
    expect(resumo).toContain('R$ 150,50')

    const soCancelada = canais.whatsapps.find((m) => m.para === proSoCancelada.ownerPhone)?.texto ?? ''
    expect(soCancelada).toMatch(/\b0 notas emitidas\b/)
    expect(soCancelada).toMatch(/\b1 cancelada\b/)
    expect(soCancelada).toContain('R$ 0,00')

    // Uma vez por mês: outra rodada no mesmo dia e no dia seguinte não repetem.
    await rodar('2026-11-01T15:00:00-03:00')
    await rodar('2026-11-02T09:30:00-03:00')
    expect(canais.whatsapps).toHaveLength(2)

    // Fora do dia 1 nada sai, mesmo para quem ainda não recebeu.
    await admin.db.query(`delete from nofiscal.fiscal_agent_once where tenant_id = any($1::uuid[])`, [ids])
    await rodar('2026-11-02T09:30:00-03:00')
    expect(canais.whatsapps).toHaveLength(2)
  })
})
