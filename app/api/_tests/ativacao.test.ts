// POST /api/v1/onboarding/ativacao, chamado pela função publicada em api/v1/onboarding/ativacao.ts
// com Request HTTP. Check C25 de .checks/agente-fiscal-v2.md. O banco é o local, com o papel
// nofiscal_service; a sessão é conferida num servidor local no papel do Supabase Auth.
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeSharedDb } from '../_lib/db.js'
import {
  allowTestUserToAssume,
  createSelfServiceTenant,
  dropSelfServiceTenant,
  roleDatabaseUrl,
  type SelfServiceTenant,
} from './agente-fixtures.js'
import { openTestDb } from './fixtures.js'

const ANON_KEY = 'anon-de-teste'
const auth: Server = createServer((req, res) => {
  const token = /^Bearer token-([0-9a-f-]{36})$/.exec(req.headers.authorization ?? '')
  if (req.method !== 'GET' || req.url !== '/auth/v1/user' || req.headers.apikey !== ANON_KEY || !token) {
    res.writeHead(401, { 'content-type': 'application/json' }).end('{"msg":"invalid JWT"}')
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: token[1], aud: 'authenticated' }))
})
await new Promise<void>((resolve) => auth.listen(0, '127.0.0.1', resolve))

process.env.SUPABASE_URL = `http://127.0.0.1:${(auth.address() as AddressInfo).port}`
process.env.SUPABASE_ANON_KEY = ANON_KEY
process.env.NOFISCAL_DATABASE_URL = roleDatabaseUrl('nofiscal_service')
process.env.WHATSAPP_NUMERO_AGENTE = '+55 (11) 90000-0001'
const { default: entry } = await import('../v1/onboarding/ativacao.js')

const URL_ROTA = 'https://app.notechstack.com.br/api/v1/onboarding/ativacao'
const admin = openTestDb()
const tenants: SelfServiceTenant[] = []

type Corpo = { codigo?: string; whatsapp_url?: string; expira_em?: string; error?: { code: string; message: string } }

function ativacao(userId: string | null, corpo: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (userId) headers.authorization = `Bearer token-${userId}`
  return entry.fetch(new Request(URL_ROTA, { method: 'POST', headers, body: JSON.stringify(corpo) }))
}

async function novoTenant(opcoes: { ativado?: boolean; onboardingEtapa?: string } = {}) {
  const s = await createSelfServiceTenant(admin.db, {
    ativado: opcoes.ativado ?? false,
    onboardingEtapa: opcoes.onboardingEtapa ?? 'clientes',
    pagoEm: new Date(),
  })
  tenants.push(s)
  return s
}

async function codigosDe(userId: string) {
  const { rows } = await admin.db.query<{ id: string; code_hash: string; expires_at: Date; created_at: Date; consumed_at: Date | null }>(
    `select id, code_hash, expires_at, created_at, consumed_at from nofiscal.fiscal_verification_codes
      where user_id = $1 and purpose = 'whatsapp_activation' order by created_at`,
    [userId],
  )
  return rows
}

beforeAll(async () => {
  await allowTestUserToAssume(admin.db, 'nofiscal_service')
})

afterAll(async () => {
  for (const s of tenants) await dropSelfServiceTenant(admin.db, s)
  await closeSharedDb()
  await admin.pool.end()
  await new Promise<void>((resolve) => auth.close(() => resolve()))
})

describe('ativação do WhatsApp pela página (C25)', () => {
  it('gera o código de ativação', async () => {
    const s = await novoTenant()
    const antes = Date.now()
    const res = await ativacao(s.ownerUserId, { tenant_id: s.tenant.id })
    expect(res.status).toBe(201)
    const corpo = (await res.json()) as Corpo
    expect(corpo.codigo).toMatch(/^\d{6}$/)
    expect(corpo.whatsapp_url).toBe(`https://wa.me/5511900000001?text=ATIVAR%20${corpo.codigo}`)

    // Vale 24 horas, e o banco guarda só o hash.
    const expira = new Date(corpo.expira_em as string).getTime()
    expect(expira - antes).toBeGreaterThanOrEqual(24 * 3600_000 - 5_000)
    expect(expira - Date.now()).toBeLessThanOrEqual(24 * 3600_000 + 5_000)
    const [codigo] = await codigosDe(s.ownerUserId)
    expect(codigo.code_hash).toBe(createHash('sha256').update(`${codigo.id}:${corpo.codigo}`).digest('hex'))
    expect(codigo.code_hash).not.toContain(corpo.codigo)
    expect(codigo.expires_at.getTime()).toBe(expira)
    expect(codigo.consumed_at).toBeNull()

    // Um código novo invalida o anterior; a etapa passa a "ativacao".
    const segunda = (await (await ativacao(s.ownerUserId, { tenant_id: s.tenant.id })).json()) as Corpo
    const codigos = await codigosDe(s.ownerUserId)
    expect(codigos).toHaveLength(2)
    expect(codigos[0].expires_at.getTime()).toBeLessThanOrEqual(Date.now())
    expect(segunda.codigo).toMatch(/^\d{6}$/)
    const { rows } = await admin.db.query<{ onboarding_etapa: string }>(
      'select onboarding_etapa from nofiscal.fiscal_tenants where id = $1',
      [s.tenant.id],
    )
    expect(rows[0].onboarding_etapa).toBe('ativacao')

    // Sem sessão: 401. Outro tenant: 403. Já ativado: 409 JA_ATIVADO. Nada é criado.
    const outro = await novoTenant()
    expect((await ativacao(null, { tenant_id: s.tenant.id })).status).toBe(401)
    const proibido = await ativacao(outro.ownerUserId, { tenant_id: s.tenant.id })
    expect(proibido.status).toBe(403)
    expect(((await proibido.json()) as Corpo).error?.code).toBe('FORBIDDEN')
    expect(await codigosDe(outro.ownerUserId)).toHaveLength(0)

    const ativo = await novoTenant({ ativado: true, onboardingEtapa: 'concluido' })
    const jaAtivado = await ativacao(ativo.ownerUserId, { tenant_id: ativo.tenant.id })
    expect(jaAtivado.status).toBe(409)
    expect(((await jaAtivado.json()) as Corpo).error?.code).toBe('JA_ATIVADO')
    expect(await codigosDe(ativo.ownerUserId)).toHaveLength(0)

    expect((await ativacao(s.ownerUserId, { tenant_id: 'nao-e-uuid' })).status).toBe(422)
  })

  it('não gera código antes de terminar o site', async () => {
    const s = await novoTenant({ onboardingEtapa: 'certificado' })
    const res = await ativacao(s.ownerUserId, { tenant_id: s.tenant.id })
    expect(res.status).toBe(409)
    expect(((await res.json()) as Corpo).error?.code).toBe('ONBOARDING_INCOMPLETO')
    expect(await codigosDe(s.ownerUserId)).toHaveLength(0)
  })

  it('sem o número do agente não cria código', async () => {
    const s = await novoTenant()
    const numero = process.env.WHATSAPP_NUMERO_AGENTE
    delete process.env.WHATSAPP_NUMERO_AGENTE
    try {
      const res = await ativacao(s.ownerUserId, { tenant_id: s.tenant.id })
      expect(res.status).toBe(500)
    } finally {
      process.env.WHATSAPP_NUMERO_AGENTE = numero
    }
    expect(await codigosDe(s.ownerUserId)).toHaveLength(0)
  })
})
