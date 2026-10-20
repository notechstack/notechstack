// Cadastro do agente fiscal: conta, códigos e números autorizados. Checks C1, C3 e C4 de
// .checks/agente-fiscal-whatsapp.md. O código sob teste conecta como `nofiscal_service`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  allowTestUserToAssume,
  canaisDouble,
  codigoDaMensagem,
  createAuthUser,
  createSelfServiceTenant,
  dropAuthUser,
  dropSelfServiceTenant,
  openRoleDb,
  randomPhone,
  type SelfServiceTenant,
} from '../../_tests/agente-fixtures.js'
import { openTestDb } from '../../_tests/fixtures.js'
import {
  autorizarNumero,
  confirmarCodigoDaConta,
  confirmarNumero,
  contaAtiva,
  criarConta,
  numeroPodeEmitir,
  reenviarCodigoDaConta,
  revogarNumero,
} from './cadastro.js'

const admin = openTestDb()
const servico = openRoleDb('nofiscal_service')
const tenants: SelfServiceTenant[] = []
const users: string[] = []

const minutos = (base: Date, n: number) => new Date(base.getTime() + n * 60_000)

beforeAll(async () => {
  await allowTestUserToAssume(admin.db, 'nofiscal_service')
  const { rows } = await servico.db.query<{ papel: string }>('select current_user as papel')
  expect(rows[0].papel).toBe('nofiscal_service')
})

afterAll(async () => {
  for (const s of tenants) await dropSelfServiceTenant(admin.db, s)
  for (const id of users) await dropAuthUser(admin.db, id)
  await servico.pool.end()
  await admin.pool.end()
})

async function novoTenant(options: Parameters<typeof createSelfServiceTenant>[1] = {}) {
  const s = await createSelfServiceTenant(admin.db, options)
  tenants.push(s)
  return s
}

describe('conta', () => {
  it('conta ativa só com os dois códigos', async () => {
    const userId = await createAuthUser(admin.db)
    users.push(userId)
    const canais = canaisDouble()
    const t0 = new Date()
    let agora = t0
    const deps = { db: servico.db, email: canais.email, whatsapp: canais.whatsapp, now: () => agora }
    const telefone = randomPhone()

    const criada = await criarConta(deps, { userId, email: ' Pessoa@Example.TEST ', telefone })
    expect(criada).toEqual({ ok: true })
    expect(canais.emails).toHaveLength(1)
    expect(canais.emails[0].para).toBe('pessoa@example.test')
    expect(canais.whatsapps).toHaveLength(1)
    expect(canais.whatsapps[0].para).toBe(telefone)
    const codigoEmail = codigoDaMensagem(canais.emails[0].texto)
    const codigoWhatsApp = codigoDaMensagem(canais.whatsapps[0].texto)
    expect(await contaAtiva(servico.db, userId)).toBe(false)

    // Só o hash fica no banco.
    const { rows: gravados } = await admin.db.query<{ code_hash: string }>(
      'select code_hash from nofiscal.fiscal_verification_codes where user_id = $1',
      [userId],
    )
    expect(gravados).toHaveLength(2)
    for (const row of gravados) {
      expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/)
      expect(row.code_hash).not.toContain(codigoEmail)
      expect(row.code_hash).not.toContain(codigoWhatsApp)
    }

    // Código errado: continua inativa.
    const errado = codigoEmail === '000000' ? '111111' : '000000'
    expect(await confirmarCodigoDaConta(deps, { userId, canal: 'email', codigo: errado })).toMatchObject({
      ok: false,
      motivo: 'CODIGO_INVALIDO',
      contaAtiva: false,
    })
    expect(await contaAtiva(servico.db, userId)).toBe(false)

    // Só o e-mail: continua inativa.
    expect(await confirmarCodigoDaConta(deps, { userId, canal: 'email', codigo: codigoEmail })).toMatchObject({
      ok: true,
      contaAtiva: false,
    })
    expect(await contaAtiva(servico.db, userId)).toBe(false)

    // Código do WhatsApp vencido (10 minutos): continua inativa.
    agora = minutos(t0, 11)
    expect(await confirmarCodigoDaConta(deps, { userId, canal: 'whatsapp', codigo: codigoWhatsApp })).toMatchObject({
      ok: false,
      motivo: 'CODIGO_VENCIDO',
      contaAtiva: false,
    })
    expect(await contaAtiva(servico.db, userId)).toBe(false)

    // Novo código do WhatsApp; o antigo deixa de valer.
    await reenviarCodigoDaConta(deps, { userId, canal: 'whatsapp' })
    expect(canais.whatsapps).toHaveLength(2)
    const novoCodigo = codigoDaMensagem(canais.whatsapps[1].texto)
    if (novoCodigo !== codigoWhatsApp) {
      expect(await confirmarCodigoDaConta(deps, { userId, canal: 'whatsapp', codigo: codigoWhatsApp })).toMatchObject({
        ok: false,
        contaAtiva: false,
      })
    }

    // Os dois confirmados: ativa.
    expect(await confirmarCodigoDaConta(deps, { userId, canal: 'whatsapp', codigo: novoCodigo })).toMatchObject({
      ok: true,
      contaAtiva: true,
    })
    expect(await contaAtiva(servico.db, userId)).toBe(true)

    const { rows } = await admin.db.query<{ email_verified_at: Date | null; phone_verified_at: Date | null }>(
      'select email_verified_at, phone_verified_at from nofiscal.fiscal_accounts where user_id = $1',
      [userId],
    )
    expect(rows[0].email_verified_at).not.toBeNull()
    expect(rows[0].phone_verified_at).not.toBeNull()

    // Código já usado não vale de novo.
    expect(await confirmarCodigoDaConta(deps, { userId, canal: 'whatsapp', codigo: novoCodigo })).toMatchObject({
      ok: false,
    })
  })

  it('cinco erros invalidam o código', async () => {
    const userId = await createAuthUser(admin.db)
    users.push(userId)
    const canais = canaisDouble()
    const deps = { db: servico.db, email: canais.email, whatsapp: canais.whatsapp }
    await criarConta(deps, { userId, email: `p-${userId.slice(0, 8)}@example.test`, telefone: randomPhone() })
    const certo = codigoDaMensagem(canais.emails[0].texto)
    const errado = certo === '000000' ? '111111' : '000000'
    for (let i = 0; i < 5; i++) {
      expect(await confirmarCodigoDaConta(deps, { userId, canal: 'email', codigo: errado })).toMatchObject({ ok: false })
    }
    expect(await confirmarCodigoDaConta(deps, { userId, canal: 'email', codigo: certo })).toMatchObject({ ok: false })
  })

  it('recusa e-mail e telefone inválidos', async () => {
    const userId = await createAuthUser(admin.db)
    users.push(userId)
    const canais = canaisDouble()
    const deps = { db: servico.db, email: canais.email, whatsapp: canais.whatsapp }
    expect(await criarConta(deps, { userId, email: 'sem-arroba', telefone: randomPhone() })).toEqual({
      ok: false,
      erro: 'EMAIL_INVALIDO',
    })
    expect(await criarConta(deps, { userId, email: 'a@example.test', telefone: '123' })).toEqual({
      ok: false,
      erro: 'TELEFONE_INVALIDO',
    })
    expect(canais.emails).toHaveLength(0)
    expect(canais.whatsapps).toHaveLength(0)
  })
})

describe('números autorizados', () => {
  it('autorizar e revogar número', async () => {
    const s = await novoTenant()
    const canais = canaisDouble()
    const deps = { db: servico.db, email: canais.email, whatsapp: canais.whatsapp }
    const telefone = randomPhone()
    const digitado = `(${telefone.slice(3, 5)}) ${telefone.slice(5, 10)}-${telefone.slice(10)}`

    const autorizado = await autorizarNumero(deps, { userId: s.ownerUserId, tenantId: s.tenant.id, telefone: digitado })
    expect(autorizado).toMatchObject({ ok: true })
    expect(canais.whatsapps).toHaveLength(1)
    expect(canais.whatsapps[0].para).toBe(telefone)

    // Sem confirmar o código, o número não emite.
    expect(await numeroPodeEmitir(servico.db, telefone)).toBeNull()
    const { rows: antes } = await admin.db.query<{ verified_at: Date | null }>(
      'select verified_at from nofiscal.fiscal_phones where phone_e164 = $1',
      [telefone],
    )
    expect(antes[0].verified_at).toBeNull()

    const codigo = codigoDaMensagem(canais.whatsapps[0].texto)
    expect(await confirmarNumero(deps, { telefone, codigo })).toMatchObject({ ok: true })
    expect(await numeroPodeEmitir(servico.db, telefone)).toEqual({
      phoneId: expect.any(String),
      tenantId: s.tenant.id,
    })

    // Revogado: para de emitir na hora.
    expect(await revogarNumero(deps, { userId: s.ownerUserId, tenantId: s.tenant.id, telefone })).toEqual({ ok: true })
    expect(await numeroPodeEmitir(servico.db, telefone)).toBeNull()
    const { rows: depois } = await admin.db.query<{ revoked_at: Date | null }>(
      'select revoked_at from nofiscal.fiscal_phones where phone_e164 = $1',
      [telefone],
    )
    expect(depois[0].revoked_at).not.toBeNull()

    // Quem não é dono não autoriza nem revoga.
    const estranho = await createAuthUser(admin.db)
    users.push(estranho)
    const outro = randomPhone()
    expect(await autorizarNumero(deps, { userId: estranho, tenantId: s.tenant.id, telefone: outro })).toMatchObject({
      ok: false,
      erro: 'FORBIDDEN',
    })
    expect(await revogarNumero(deps, { userId: estranho, tenantId: s.tenant.id, telefone: s.ownerPhone })).toMatchObject({
      ok: false,
      erro: 'FORBIDDEN',
    })
    const { rows: nada } = await admin.db.query('select 1 from nofiscal.fiscal_phones where phone_e164 = $1', [outro])
    expect(nada).toHaveLength(0)
    expect(canais.whatsapps).toHaveLength(1)

    // O número do dono não é revogável.
    expect(
      await revogarNumero(deps, { userId: s.ownerUserId, tenantId: s.tenant.id, telefone: s.ownerPhone }),
    ).toMatchObject({ ok: false, erro: 'NUMERO_DO_DONO' })
    expect(await numeroPodeEmitir(servico.db, s.ownerPhone)).toEqual({ phoneId: expect.any(String), tenantId: s.tenant.id })

    // Reautorizar o revogado pede código novo e só emite depois de confirmar.
    expect(await autorizarNumero(deps, { userId: s.ownerUserId, tenantId: s.tenant.id, telefone })).toMatchObject({ ok: true })
    expect(await numeroPodeEmitir(servico.db, telefone)).toBeNull()
    expect(await confirmarNumero(deps, { telefone, codigo: codigoDaMensagem(canais.whatsapps[1].texto) })).toMatchObject({
      ok: true,
    })
    expect(await numeroPodeEmitir(servico.db, telefone)).toMatchObject({ tenantId: s.tenant.id })
  })

  it('número de outra empresa', async () => {
    const a = await novoTenant()
    const b = await novoTenant()
    const canais = canaisDouble()
    const deps = { db: servico.db, email: canais.email, whatsapp: canais.whatsapp }
    const telefone = randomPhone()

    expect(await autorizarNumero(deps, { userId: a.ownerUserId, tenantId: a.tenant.id, telefone })).toMatchObject({ ok: true })
    const enviados = canais.whatsapps.length

    const segunda = await autorizarNumero(deps, { userId: b.ownerUserId, tenantId: b.tenant.id, telefone })
    expect(segunda).toEqual({
      ok: false,
      erro: 'NUMERO_DE_OUTRA_EMPRESA',
      mensagem: 'Este WhatsApp já está ligado a outra empresa',
    })
    // O número do dono de A também não entra em B.
    expect(
      await autorizarNumero(deps, { userId: b.ownerUserId, tenantId: b.tenant.id, telefone: a.ownerPhone }),
    ).toMatchObject({ ok: false, mensagem: 'Este WhatsApp já está ligado a outra empresa' })
    expect(canais.whatsapps).toHaveLength(enviados)

    const { rows } = await admin.db.query<{ tenant_id: string }>(
      'select tenant_id from nofiscal.fiscal_phones where phone_e164 = any($1::text[])',
      [[telefone, a.ownerPhone]],
    )
    expect(rows.map((row) => row.tenant_id)).toEqual([a.tenant.id, a.tenant.id])
  })
})
