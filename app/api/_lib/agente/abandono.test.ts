// Lista diária de abandono. Check C48 de .checks/agente-fiscal-v2.md. O código sob teste conecta
// como `nofiscal_service`; o e-mail é um dublê. A marca do dia (`abandono:<dia>`) não tem tenant:
// o teste apaga as dos dias que usa, antes e depois.
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
import { enviarListaDeAbandono } from './abandono.js'

const admin = openTestDb()
const servico = openRoleDb('nofiscal_service')
const tenants: SelfServiceTenant[] = []
const DIAS = ['2026-11-10', '2026-11-11', '2026-11-12']
const limparMarcas = () =>
  admin.db.query('delete from nofiscal.fiscal_agent_once where chave = any($1::text[])', [DIAS.map((d) => `abandono:${d}`)])

beforeAll(async () => {
  await allowTestUserToAssume(admin.db, 'nofiscal_service')
  await limparMarcas()
})

afterAll(async () => {
  await limparMarcas()
  for (const s of tenants) await dropSelfServiceTenant(admin.db, s)
  await servico.pool.end()
  await admin.pool.end()
})

async function tenant(opcoes: {
  razaoSocial: string
  plan: 'inicial' | 'pro'
  onboardingEtapa: string
  pagoEm: string | null
  trialEndsAt?: string | null
  responsavel?: string
}) {
  const s = await createSelfServiceTenant(admin.db, {
    plan: opcoes.plan,
    onboardingEtapa: opcoes.onboardingEtapa,
    ativado: opcoes.onboardingEtapa === 'concluido',
    pagoEm: opcoes.pagoEm ? new Date(opcoes.pagoEm) : null,
    razaoSocial: opcoes.razaoSocial,
  })
  tenants.push(s)
  await admin.db.query('update nofiscal.fiscal_tenants set trial_ends_at = $2 where id = $1', [s.tenant.id, opcoes.trialEndsAt ?? null])
  if (opcoes.responsavel) {
    await admin.db.query(`update auth.users set raw_user_meta_data = jsonb_build_object('responsavel', $2::text) where id = $1`, [
      s.ownerUserId,
      opcoes.responsavel,
    ])
  }
  return s
}

describe('lista de abandono', () => {
  it('lista diária de abandono', async () => {
    const parado = await tenant({
      razaoSocial: 'PAROU NO CERTIFICADO LTDA',
      plan: 'pro',
      onboardingEtapa: 'certificado',
      pagoEm: '2026-11-09T15:00:00-03:00',
      trialEndsAt: '2026-11-14T20:00:00-03:00',
      responsavel: 'Ana Responsável',
    })
    const semTeste = await tenant({
      razaoSocial: 'PAROU NAS BOAS VINDAS LTDA',
      plan: 'inicial',
      onboardingEtapa: 'boas_vindas_cliente',
      pagoEm: '2026-11-10T07:00:00-03:00',
      trialEndsAt: null,
    })
    const recente = await tenant({
      razaoSocial: 'PAGOU AGORA LTDA',
      plan: 'pro',
      onboardingEtapa: 'certificado',
      pagoEm: '2026-11-10T07:30:00-03:00',
    })
    const concluido = await tenant({
      razaoSocial: 'CONCLUIU LTDA',
      plan: 'pro',
      onboardingEtapa: 'concluido',
      pagoEm: '2026-11-08T10:00:00-03:00',
    })
    const naoPagou = await tenant({ razaoSocial: 'NAO PAGOU LTDA', plan: 'pro', onboardingEtapa: 'pagamento', pagoEm: null })

    const canais = canaisDouble()
    const ids = [parado, semTeste, recente, concluido, naoPagou].map((s) => s.tenant.id)
    const rodar = (instante: string, alertaEmail: string | null = 'lucca@example.test') =>
      enviarListaDeAbandono(
        { db: servico.db, email: canais.email, alertaEmail: alertaEmail ?? undefined, now: () => new Date(instante) },
        { tenantIds: ids },
      )

    // Antes das 08:00: nada, e o dia não é gasto.
    await rodar('2026-11-10T07:59:00-03:00')
    expect(canais.emails).toHaveLength(0)

    await rodar('2026-11-10T08:00:00-03:00')
    expect(canais.emails).toHaveLength(1)
    const email = canais.emails[0]
    expect(email.para).toBe('lucca@example.test')
    const linhas = email.texto.split('\n').filter((l) => l.includes('LTDA'))
    expect(linhas).toEqual([
      `PAROU NO CERTIFICADO LTDA · Ana Responsável · ${parado.ownerPhone} · pro · certificado · 5 dias de teste`,
      `PAROU NAS BOAS VINDAS LTDA · ${semTeste.ownerEmail} · ${semTeste.ownerPhone} · inicial · boas_vindas_cliente · sem teste`,
    ])

    // Uma vez por dia.
    await rodar('2026-11-10T08:01:00-03:00')
    await rodar('2026-11-10T18:00:00-03:00')
    expect(canais.emails).toHaveLength(1)

    // Lista vazia (todos concluíram): nada é enviado.
    await admin.db.query(`update nofiscal.fiscal_tenants set onboarding_etapa = 'concluido' where id = any($1::uuid[])`, [ids])
    await rodar('2026-11-11T08:30:00-03:00')
    expect(canais.emails).toHaveLength(1)

    // Sem FISCAL_ALERTA_EMAIL, nada roda.
    await admin.db.query(`update nofiscal.fiscal_tenants set onboarding_etapa = 'certificado' where id = $1`, [parado.tenant.id])
    await rodar('2026-11-12T08:30:00-03:00', null)
    expect(canais.emails).toHaveLength(1)
  })
})
