// Utilitários dos testes do agente fiscal. Como os do motor, rodam contra o banco local do
// Supabase; a diferença é que o código sob teste conecta com o papel de produção
// (`nofiscal_service` ou `nofiscal_onboarding`), pela opção `-c role=…` da conexão, para a
// prova cobrir também os grants (Landing de .checks/agente-fiscal-whatsapp.md, lote A).
import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import type { EnviaEmail, EnviaWhatsApp, MensagemEmail } from '../_lib/agente/canais.js'
import { createDb, type Db } from '../_lib/db.js'
import { createTestTenant, dropTestTenant, TEST_DATABASE_URL, type TestTenant, type TestTenantOptions } from './fixtures.js'

export type PapelDoBanco = 'nofiscal_service' | 'nofiscal_onboarding'

function assertLocal(url: string) {
  const host = new URL(url).hostname
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error('os testes do agente só dão GRANT de papel no banco local')
  }
}

/** URL do banco de teste que entra direto com o papel pedido. */
export function roleDatabaseUrl(role: PapelDoBanco): string {
  const url = new URL(TEST_DATABASE_URL)
  url.searchParams.set('options', `-c role=${role}`)
  return url.toString()
}

/**
 * No Postgres 15 quem cria um papel não o assume sem GRANT. No banco local o `postgres`
 * passa a ser membro dos dois papéis (idempotente); em banco remoto, recusa.
 */
export async function allowTestUserToAssume(db: Db, ...roles: PapelDoBanco[]): Promise<void> {
  assertLocal(TEST_DATABASE_URL)
  for (const role of roles) await db.query(`grant ${role} to postgres`)
}

export function openRoleDb(role: PapelDoBanco): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: roleDatabaseUrl(role), max: 2 })
  return { db: createDb(pool), pool }
}

export const randomPhone = () =>
  `+55119${Array.from(randomBytes(8), (byte) => String(byte % 10)).join('')}`

export async function createAuthUser(db: Db, email = `pessoa-${randomBytes(6).toString('hex')}@example.test`): Promise<string> {
  const id = randomUUID()
  await db.query(
    `insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ($1, 'authenticated', 'authenticated', $2, '{"role":"CLIENT"}', '{}', now(), now())`,
    [id, email],
  )
  return id
}

export type SelfServiceTenant = {
  tenant: TestTenant
  ownerUserId: string
  ownerEmail: string
  ownerPhone: string
  clientId: string
}

export type SelfServiceOptions = TestTenantOptions & {
  plan?: 'inicial' | 'pro'
  contadorEmail?: string | null
}

/** Tenant do self-service: usuário dono, `clients`, `memberships`, conta ativa e número do dono. */
export async function createSelfServiceTenant(db: Db, options: SelfServiceOptions = {}): Promise<SelfServiceTenant> {
  const ownerEmail = `dono-${randomBytes(6).toString('hex')}@example.test`
  const ownerPhone = randomPhone()
  const ownerUserId = await createAuthUser(db, ownerEmail)
  const clientId = randomUUID()
  await db.query('insert into public.clients (id, name, slug) values ($1, $2, $3)', [
    clientId,
    `Cliente ${clientId.slice(0, 8)}`,
    `agente-fiscal-${clientId}`,
  ])
  await db.query(`insert into public.memberships (user_id, client_id, role) values ($1, $2, 'CLIENT')`, [ownerUserId, clientId])
  await db.query(
    `insert into nofiscal.fiscal_accounts (user_id, email, phone_e164, email_verified_at, phone_verified_at, client_id)
     values ($1, $2, $3, now(), now(), $4)`,
    [ownerUserId, ownerEmail, ownerPhone, clientId],
  )
  const tenant = await createTestTenant(db, options)
  const plan = options.plan ?? 'pro'
  await db.query(
    `update nofiscal.fiscal_tenants
        set client_id = $2, plan = $3, monthly_note_limit = $4, contador_email = $5
      where id = $1`,
    [tenant.id, clientId, plan, plan === 'pro' ? 100 : 20, options.contadorEmail ?? null],
  )
  await db.query(
    `insert into nofiscal.fiscal_phones (tenant_id, phone_e164, role, verified_at) values ($1, $2, 'owner', now())`,
    [tenant.id, ownerPhone],
  )
  return { tenant, ownerUserId, ownerEmail, ownerPhone, clientId }
}

/** Apaga o que o agente gravou no tenant e o tenant (com os segredos do Vault). */
export async function dropSelfServiceTenant(db: Db, s: SelfServiceTenant): Promise<void> {
  await dropAgenteRows(db, s.tenant.id)
  await dropTestTenant(db, s.tenant.id)
  await db.query('delete from nofiscal.fiscal_accounts where client_id = $1', [s.clientId])
  await db.query('delete from public.memberships where client_id = $1', [s.clientId])
  await db.query('delete from public.clients where id = $1', [s.clientId])
  await db.query('delete from auth.users where id = $1', [s.ownerUserId])
}

export async function dropAgenteRows(db: Db, tenantId: string): Promise<void> {
  await db.query('delete from nofiscal.fiscal_requests where tenant_id = $1', [tenantId])
  await db.query('delete from nofiscal.fiscal_models where tenant_id = $1', [tenantId])
  await db.query(
    'delete from nofiscal.fiscal_verification_codes where phone_id in (select id from nofiscal.fiscal_phones where tenant_id = $1)',
    [tenantId],
  )
  await db.query('delete from nofiscal.fiscal_phones where tenant_id = $1', [tenantId])
  await db.query('delete from nofiscal.fiscal_certificate_attempts where tenant_id = $1', [tenantId])
  await db.query('delete from nofiscal.fiscal_subscriptions where tenant_id = $1', [tenantId])
}

export async function dropAuthUser(db: Db, userId: string): Promise<void> {
  await db.query('delete from nofiscal.fiscal_accounts where user_id = $1', [userId])
  await db.query('delete from auth.users where id = $1', [userId])
}

/** Dublê dos canais: guarda o que seria enviado, na ordem. */
export function canaisDouble(): {
  email: EnviaEmail
  whatsapp: EnviaWhatsApp
  emails: MensagemEmail[]
  whatsapps: { para: string; texto: string }[]
} {
  const emails: MensagemEmail[] = []
  const whatsapps: { para: string; texto: string }[] = []
  return {
    emails,
    whatsapps,
    email: {
      async enviar(mensagem) {
        emails.push(mensagem)
      },
    },
    whatsapp: {
      async enviarTexto(para, texto) {
        whatsapps.push({ para, texto })
      },
    },
  }
}

/** O código como a pessoa o lê na mensagem: os 6 dígitos do texto. */
export function codigoDaMensagem(texto: string): string {
  const match = texto.match(/\b(\d{6})\b/)
  if (!match) throw new Error('mensagem sem código de 6 dígitos')
  return match[1]
}
