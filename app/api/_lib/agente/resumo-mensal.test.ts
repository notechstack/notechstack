// Resumo periódico do Pro no WhatsApp. Check C38 de .checks/agente-fiscal-whatsapp.md (v1, agora
// com `resumo_frequencia = 'mensal'` e `resumo_dia = 1`) e checks C35 a C37 de
// .checks/agente-fiscal-v2.md. O código sob teste conecta como `nofiscal_service`; o WhatsApp é
// um dublê. A janela de 24 h da Meta é aberta gravando uma mensagem recebida do dono.
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
import { registrarJanela } from './janela.js'
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

type Resumo = { frequencia: 'mensal' | 'semanal'; dia: number }

async function tenant(plan: 'inicial' | 'pro', resumo: Resumo | null = { frequencia: 'mensal', dia: 1 }) {
  const s = await createSelfServiceTenant(admin.db, { plan })
  tenants.push(s)
  if (resumo) {
    await admin.db.query('update nofiscal.fiscal_tenants set resumo_frequencia = $2, resumo_dia = $3 where id = $1', [
      s.tenant.id,
      resumo.frequencia,
      resumo.dia,
    ])
  }
  return s
}

/** O dono escreveu ao agente nesse instante (abre a janela de 24 h). */
const escreveu = (s: SelfServiceTenant, instante: string) => registrarJanela(servico.db, s.ownerPhone, new Date(instante))

async function marcasDeResumo(tenantId: string) {
  const { rows } = await admin.db.query<{ chave: string }>(
    `select chave from nofiscal.fiscal_agent_once where tenant_id = $1 and chave like 'resumo:%' order by chave`,
    [tenantId],
  )
  return rows.map((r) => r.chave)
}

function rodador(ids: string[], modelos: { resumo?: string } = {}) {
  const canais = canaisDouble()
  const rodar = (instante: string) =>
    enviarResumoMensal(
      { db: servico.db, whatsapp: canais.whatsapp, email: canais.email, links: LINKS_DE_TESTE, modelos, now: () => new Date(instante) },
      { tenantIds: ids },
    )
  return { canais, rodar }
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

    for (const s of [pro, proSemNotas, inicial, proSoCancelada]) await escreveu(s, '2026-11-01T08:00:00-03:00')
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

  it('resumo mensal no dia escolhido', async () => {
    const naJanela = await tenant('pro', { frequencia: 'mensal', dia: 5 })
    const foraDaJanela = await tenant('pro', { frequencia: 'mensal', dia: 5 })
    for (const s of [naJanela, foraDaJanela]) {
      await nota(s, { valor: '100.00', emitidaEm: '2026-10-05T12:00:00-03:00' })
      await nota(s, { valor: '20.00', emitidaEm: '2026-10-20T12:00:00-03:00', status: 'cancelled', canceladaEm: '2026-10-21T12:00:00-03:00' })
      await nota(s, { valor: '999.00', emitidaEm: '2026-11-02T12:00:00-03:00' })
    }
    await escreveu(naJanela, '2026-11-04T18:00:00-03:00')
    await escreveu(foraDaJanela, '2026-11-03T18:00:00-03:00')
    const { canais, rodar } = rodador([naJanela.tenant.id, foraDaJanela.tenant.id], { resumo: 'resumo_nofiscal' })

    // Dia 1 (o padrão antigo), dia 4 e dia 5 antes das 09:00: nada.
    await rodar('2026-11-01T09:30:00-03:00')
    await rodar('2026-11-04T09:30:00-03:00')
    await rodar('2026-11-05T08:59:00-03:00')
    expect(canais.whatsapps).toHaveLength(0)

    await rodar('2026-11-05T09:00:00-03:00')
    expect(canais.whatsapps).toHaveLength(2)
    const texto = canais.whatsapps.find((m) => m.para === naJanela.ownerPhone)
    expect(texto?.modelo).toBeUndefined()
    expect(texto?.texto).toContain('outubro/2026')
    expect(texto?.texto).toMatch(/\b2 notas emitidas\b/)
    expect(texto?.texto).toMatch(/\b1 cancelada\b/)
    expect(texto?.texto).toContain('R$ 100,00')

    // Fora da janela de 24 h: o modelo WHATSAPP_MODELO_RESUMO, com os mesmos números.
    const modelo = canais.whatsapps.find((m) => m.para === foraDaJanela.ownerPhone)
    expect(modelo?.modelo).toEqual({ nome: 'resumo_nofiscal', parametros: ['outubro/2026', '2', '1', 'R$ 100,00'] })

    // Uma vez: o resto do dia 5 e o dia 6 não repetem.
    await rodar('2026-11-05T15:00:00-03:00')
    await rodar('2026-11-06T09:30:00-03:00')
    expect(canais.whatsapps).toHaveLength(2)
    expect(await marcasDeResumo(naJanela.tenant.id)).toEqual([`resumo:${naJanela.tenant.id}:2026-10`])
  })

  it('resumo semanal', async () => {
    const s = await tenant('pro', { frequencia: 'semanal', dia: 1 })
    // 02/11/2026 é segunda. Semana anterior: 26/10 (segunda) a 01/11 (domingo).
    await nota(s, { valor: '1.00', emitidaEm: '2026-10-25T23:30:00-03:00' })
    await nota(s, { valor: '10.00', emitidaEm: '2026-10-26T00:10:00-03:00' })
    await nota(s, { valor: '15.50', emitidaEm: '2026-11-01T23:50:00-03:00' })
    await nota(s, { valor: '7.00', emitidaEm: '2026-11-02T08:00:00-03:00' })
    const { canais, rodar } = rodador([s.tenant.id])

    await escreveu(s, '2026-11-02T07:00:00-03:00')
    await rodar('2026-11-02T08:59:00-03:00')
    expect(canais.whatsapps).toHaveLength(0)
    await rodar('2026-11-02T09:01:00-03:00')
    expect(canais.whatsapps).toHaveLength(1)
    const primeira = canais.whatsapps[0].texto
    expect(primeira).toContain('semana de 26/10 a 01/11')
    expect(primeira).toMatch(/\b2 notas emitidas\b/)
    expect(primeira).toContain('R$ 25,50')

    // O resto da segunda e a terça: nada.
    await rodar('2026-11-02T18:00:00-03:00')
    await rodar('2026-11-03T09:30:00-03:00')
    expect(canais.whatsapps).toHaveLength(1)

    // Segunda seguinte: a semana de 02/11 a 08/11, com a nota de 02/11.
    await escreveu(s, '2026-11-09T07:00:00-03:00')
    await rodar('2026-11-09T09:30:00-03:00')
    expect(canais.whatsapps).toHaveLength(2)
    expect(canais.whatsapps[1].texto).toContain('semana de 02/11 a 08/11')
    expect(canais.whatsapps[1].texto).toMatch(/\b1 nota emitida\b/)
    expect(await marcasDeResumo(s.tenant.id)).toEqual([`resumo:${s.tenant.id}:2026-W44`, `resumo:${s.tenant.id}:2026-W45`])
  })

  it('pro sem frequência gravada recebe no dia 1', async () => {
    const s = await tenant('pro', null)
    await nota(s, { valor: '30.00', emitidaEm: '2026-10-10T10:00:00-03:00' })
    await escreveu(s, '2026-11-01T08:00:00-03:00')
    const { canais, rodar } = rodador([s.tenant.id])
    await rodar('2026-11-01T09:30:00-03:00')
    expect(canais.whatsapps).toHaveLength(1)
    expect(canais.whatsapps[0].texto).toContain('outubro/2026')
  })

  it('resumo não repete nem vai ao inicial', async () => {
    const inicial = await tenant('inicial', { frequencia: 'mensal', dia: 5 })
    const proSemNotas = await tenant('pro', { frequencia: 'mensal', dia: 5 })
    const pro = await tenant('pro', { frequencia: 'mensal', dia: 5 })
    await nota(inicial, { valor: '80.00', emitidaEm: '2026-10-08T10:00:00-03:00' })
    await nota(proSemNotas, { valor: '5.00', emitidaEm: '2026-09-15T10:00:00-03:00' })
    await nota(pro, { valor: '50.00', emitidaEm: '2026-10-08T10:00:00-03:00' })
    for (const s of [inicial, proSemNotas, pro]) await escreveu(s, '2026-11-05T08:00:00-03:00')
    const { canais, rodar } = rodador([inicial, proSemNotas, pro].map((s) => s.tenant.id), { resumo: 'resumo_nofiscal' })

    await rodar('2026-11-05T09:30:00-03:00')
    await rodar('2026-11-05T09:31:00-03:00')
    await rodar('2026-11-05T20:00:00-03:00')
    expect(canais.whatsapps.map((m) => m.para)).toEqual([pro.ownerPhone])
    expect(await marcasDeResumo(inicial.tenant.id)).toEqual([])
    expect(await marcasDeResumo(proSemNotas.tenant.id)).toEqual([])
    expect(await marcasDeResumo(pro.tenant.id)).toEqual([`resumo:${pro.tenant.id}:2026-10`])

    // Duas rodadas simultâneas do mesmo período: um envio só.
    const outro = await tenant('pro', { frequencia: 'mensal', dia: 5 })
    await nota(outro, { valor: '50.00', emitidaEm: '2026-10-08T10:00:00-03:00' })
    await escreveu(outro, '2026-11-05T08:00:00-03:00')
    const simultaneo = rodador([outro.tenant.id])
    await Promise.all([simultaneo.rodar('2026-11-05T09:30:00-03:00'), simultaneo.rodar('2026-11-05T09:30:00-03:00')])
    expect(simultaneo.canais.whatsapps).toHaveLength(1)
  })
})
