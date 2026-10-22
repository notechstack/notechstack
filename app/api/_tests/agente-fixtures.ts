// Utilitários dos testes do agente fiscal. Como os do motor, rodam contra o banco local do
// Supabase; a diferença é que o código sob teste conecta com o papel de produção
// (`nofiscal_service` ou `nofiscal_onboarding`), pela opção `-c role=…` da conexão, para a
// prova cobrir também os grants (Landing de .checks/agente-fiscal-whatsapp.md, lote A).
import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import type { AnexoEmail, EnviaEmail, EnviaWhatsApp, MensagemEmail } from '../_lib/agente/canais.js'
import type { MensagemRecebida } from '../_lib/agente/conversa.js'
import type { Interprete, Parsed } from '../_lib/agente/interprete.js'
import type { Links } from '../_lib/agente/links.js'
import type { SefinClient } from '../_lib/sefin.js'
import { handleWorkerRequest } from '../_lib/worker-route.js'
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
  /** Etapa do onboarding da v2; padrão `concluido`, como um tenant que já passou pelas boas-vindas. */
  onboardingEtapa?: string
  /** WhatsApp do dono já ativado (conta e `fiscal_phones`); padrão `true`. */
  ativado?: boolean
  pagoEm?: Date | null
  razaoSocial?: string
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
  const ativado = options.ativado ?? true
  await db.query(
    `insert into nofiscal.fiscal_accounts (user_id, email, phone_e164, email_verified_at, phone_verified_at, client_id)
     values ($1, $2, $3, now(), case when $5 then now() end, $4)`,
    [ownerUserId, ownerEmail, ownerPhone, clientId, ativado],
  )
  const tenant = await createTestTenant(db, options)
  const plan = options.plan ?? 'pro'
  await db.query(
    `update nofiscal.fiscal_tenants
        set client_id = $2, plan = $3, monthly_note_limit = $4, contador_email = $5,
            codigo_servico_nacional = '010701', onboarding_etapa = $6, pago_em = $7,
            razao_social = coalesce($8, razao_social)
      where id = $1`,
    [
      tenant.id,
      clientId,
      plan,
      plan === 'pro' ? 100 : 20,
      options.contadorEmail ?? null,
      options.onboardingEtapa ?? 'concluido',
      options.pagoEm ?? null,
      options.razaoSocial ?? null,
    ],
  )
  await db.query(
    `insert into nofiscal.fiscal_phones (tenant_id, phone_e164, role, verified_at) values ($1, $2, 'owner', case when $3 then now() end)`,
    [tenant.id, ownerPhone, ativado],
  )
  return { tenant, ownerUserId, ownerEmail, ownerPhone, clientId }
}

/** Apaga o que o agente gravou no tenant e o tenant (com os segredos do Vault). */
export async function dropSelfServiceTenant(db: Db, s: SelfServiceTenant): Promise<void> {
  await dropAgenteRows(db, s.tenant.id)
  await dropTestTenant(db, s.tenant.id)
  await db.query('delete from nofiscal.fiscal_verification_codes where user_id = $1', [s.ownerUserId])
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

/** O que o dublê guardou; modelo (v2) entra com o nome e os parâmetros. */
export type MensagemDeWhatsApp = { para: string; texto: string; anexo?: AnexoEmail; modelo?: { nome: string; parametros: string[] } }

/** Dublê dos canais: guarda o que seria enviado, na ordem. Documento entra com a legenda em `texto`. */
export function canaisDouble(): {
  email: EnviaEmail
  whatsapp: EnviaWhatsApp
  emails: MensagemEmail[]
  whatsapps: MensagemDeWhatsApp[]
} {
  const emails: MensagemEmail[] = []
  const whatsapps: MensagemDeWhatsApp[] = []
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
      async enviarDocumento(para, anexo, legenda) {
        whatsapps.push({ para, texto: legenda, anexo })
      },
      async enviarModelo(para, nome, parametros) {
        whatsapps.push({ para, texto: `[modelo ${nome}] ${parametros.join(' | ')}`, modelo: { nome, parametros } })
      },
    },
  }
}

// ---------------------------------------------------------------------------------------
// Lote B: conversa no WhatsApp.

/**
 * Dublê do intérprete por IA: responde só aos textos roteirizados e falha em qualquer outro,
 * para o teste provar quais mensagens chegaram à IA. Campos a mais passam adiante, como uma
 * IA desobediente faria; quem valida é o código da conversa.
 */
export function interpreteDouble(
  respostas: Record<string, Partial<Parsed> & Record<string, unknown>>,
  tokens: { entrada: number; saida: number } = { entrada: 100, saida: 20 },
): { interprete: Interprete; chamadas: string[] } {
  const chamadas: string[] = []
  return {
    chamadas,
    interprete: {
      async interpretar(texto) {
        chamadas.push(texto)
        const resposta = respostas[texto]
        if (!resposta) throw new Error(`intérprete de teste sem resposta para: ${texto}`)
        const parsed = { tomador: null, documento: null, valor: null, modelo: null, intencao: 'outro', ...resposta }
        return { parsed: parsed as unknown as Parsed, tokens }
      },
    },
  }
}

/** Assinatura gravada como o lote C grava (aqui direto, como `postgres`). */
export async function assinarTenant(
  db: Db,
  tenantId: string,
  opcoes: { status?: 'pendente' | 'paga' | 'recusada' | 'cancelada'; trialEndsAt?: Date | null } = {},
): Promise<void> {
  await db.query(
    `insert into nofiscal.fiscal_subscriptions (tenant_id, plano, com_teste, pagarme_subscription_id, status, aceite_em, aceite_texto)
     select id, case plan when 'pro' then 'pro' else 'inicial' end, $3, $4, $2, now(), 'Li e aceito os Termos (teste)'
       from nofiscal.fiscal_tenants where id = $1`,
    [tenantId, opcoes.status ?? 'paga', opcoes.trialEndsAt != null, `sub_teste_${randomBytes(8).toString('hex')}`],
  )
  if (opcoes.trialEndsAt !== undefined) {
    await db.query('update nofiscal.fiscal_tenants set trial_ends_at = $2 where id = $1', [tenantId, opcoes.trialEndsAt])
  }
}

export type ModeloDeTeste = {
  nome: string
  documento: string
  nomeTomador: string
  email?: string | null
  codigo?: string
  descricao?: string
  valorPadrao?: string | null
}

/** Modelo nascido de uma nota emitida (a nota de origem é gravada antes, como `issued`). */
export async function criarModelo(db: Db, tenantId: string, modelo: ModeloDeTeste): Promise<{ id: string; origemId: string }> {
  const origem = await db.query<{ id: string }>(
    `insert into nofiscal.fiscal_invoices (tenant_id, external_id, payload, status, issued_at)
     values ($1, $2, $3::jsonb, 'issued', now() - interval '40 days') returning id`,
    [tenantId, `origem-modelo-${randomBytes(6).toString('hex')}`, JSON.stringify({ origem: 'modelo de teste' })],
  )
  const { rows } = await db.query<{ id: string }>(
    `insert into nofiscal.fiscal_models (tenant_id, nome, tomador_documento, tomador_nome, tomador_email,
        codigo_servico_nacional, descricao, valor_padrao, created_from_invoice_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [
      tenantId,
      modelo.nome,
      modelo.documento,
      modelo.nomeTomador,
      modelo.email ?? null,
      modelo.codigo ?? '010701',
      modelo.descricao ?? 'Consultoria',
      modelo.valorPadrao ?? null,
      origem.rows[0].id,
    ],
  )
  return { id: rows[0].id, origemId: origem.rows[0].id }
}

let sequenciaDeMensagem = 0
/** Mensagem de texto como o webhook a entrega à conversa. */
export function mensagemDeTexto(de: string, texto: string, id = `wamid.teste-${randomBytes(8).toString('hex')}-${++sequenciaDeMensagem}`): MensagemRecebida {
  return { id, de, tipo: 'text', texto, arquivo: null }
}

export function mensagemDeArquivo(de: string, nome: string, mime: string): MensagemRecebida {
  return {
    id: `wamid.teste-${randomBytes(8).toString('hex')}-${++sequenciaDeMensagem}`,
    de,
    tipo: 'document',
    texto: null,
    arquivo: { nome, mime },
  }
}

/** Pedidos do tenant, do mais antigo para o mais recente. */
export async function pedidosDo(db: Db, tenantId: string) {
  const { rows } = await db.query<{
    id: string
    phone_id: string
    kind: string
    status: string
    etapa: string | null
    parsed: Record<string, unknown>
    invoice_id: string | null
    message_count: number
    ai_input_tokens: number
    ai_output_tokens: number
    expires_at: Date
  }>('select * from nofiscal.fiscal_requests where tenant_id = $1 order by created_at, id', [tenantId])
  return rows
}

export const LINKS_DE_TESTE: Links = {
  site: 'https://site.test/agentes/fiscal/',
  certificado: 'https://site.test/agentes/fiscal/certificado/',
  assinatura: 'https://site.test/agentes/fiscal/assinatura/',
  conta: 'https://site.test/agentes/fiscal/conta/',
}

/** Uma rodada do worker do motor, restrita ao tenant, com o agente ligado aos canais de teste. */
export async function rodarWorker(
  db: Db,
  opcoes: {
    sefin: SefinClient
    tenantId: string
    canais: { email: EnviaEmail; whatsapp: EnviaWhatsApp }
    now: () => Date
  },
): Promise<Record<string, unknown>> {
  const response = await handleWorkerRequest(
    new Request('https://app.notechstack.com.br/api/internal/nfse-worker', { headers: { authorization: 'Bearer segredo-do-cron' } }),
    {
      db,
      sefin: opcoes.sefin,
      cronSecret: 'segredo-do-cron',
      fetch: async () => {
        throw new Error('tenant self-service não usa o callback HTTP')
      },
      now: opcoes.now,
      tenantId: opcoes.tenantId,
      agente: { whatsapp: opcoes.canais.whatsapp, email: opcoes.canais.email, links: LINKS_DE_TESTE, now: opcoes.now },
    },
  )
  if (response.status !== 200) throw new Error(`worker respondeu ${response.status}`)
  return (await response.json()) as Record<string, unknown>
}

/** Notas do tenant criadas pelo agente (external_id = id de um pedido). */
export async function notasDoAgente(db: Db, tenantId: string) {
  const { rows } = await db.query<{ id: string; external_id: string; status: string; payload: Record<string, unknown> }>(
    `select i.id, i.external_id, i.status, i.payload
       from nofiscal.fiscal_invoices i
      where i.tenant_id = $1
        and exists (select 1 from nofiscal.fiscal_requests r where r.id::text = i.external_id)
      order by i.created_at`,
    [tenantId],
  )
  return rows
}

/** O código como a pessoa o lê na mensagem: os 6 dígitos do texto. */
export function codigoDaMensagem(texto: string): string {
  const match = texto.match(/\b(\d{6})\b/)
  if (!match) throw new Error('mensagem sem código de 6 dígitos')
  return match[1]
}
