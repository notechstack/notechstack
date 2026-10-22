// Utilitários dos testes do Nó Fiscal. Os testes rodam contra o banco local do Supabase
// (Landing, lote 2a - testes da API), conectados como `postgres`, cada um com tenant
// próprio, apagado no fim junto com os segredos que criou no Supabase Vault.
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { hashApiKey } from '../_lib/auth.js'
import { createDb, type Db } from '../_lib/db.js'
import type {
  CancelarResultado,
  ConsultaCancelamentoResultado,
  ConsultaResultado,
  EmitirResultado,
  SefinClient,
  SefinInvoice,
  SefinTenant,
  Certificado,
} from '../_lib/sefin.js'

export const TEST_DATABASE_URL =
  process.env.NOFISCAL_TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

export function openTestDb(): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 })
  return { db: createDb(pool), pool }
}

export type TestTenant = {
  id: string
  cnpj: string
  apiKey: string
  serie: string | null
  certificado: Certificado | null
  webhookSecret: string | null
  webhookUrl: string | null
}

export type TestTenantOptions = {
  active?: boolean
  /** `null` = sem certificado. Padrão: válido por um ano a partir de agora. */
  notAfter?: Date | null
  monthlyNoteLimit?: number
  /** `null` = sem série. */
  serie?: string | null
  nextNumber?: number
  webhookUrl?: string | null
  withWebhookSecret?: boolean
  /** `fiscal_tenants.p_tot_trib_sn`; `null` = não configurado. Padrão: '6.00'. */
  pTotTribSn?: string | null
  ambiente?: 'producao_restrita' | 'producao'
  /** A1 a gravar no Supabase Vault (um PFX de verdade, de `certs.ts`); padrão: texto aleatório. */
  certificado?: Certificado
}

const randomDigits = (n: number) =>
  Array.from(randomBytes(n), (byte) => String(byte % 10)).join('')

export async function createTestTenant(db: Db, options: TestTenantOptions = {}): Promise<TestTenant> {
  const cnpj = randomDigits(14)
  const apiKey = `nfk_test_${randomBytes(24).toString('base64url')}`
  const webhookUrl = options.webhookUrl === undefined ? null : options.webhookUrl
  const { rows } = await db.query<{ id: string }>(
    `insert into nofiscal.fiscal_tenants
       (cnpj, razao_social, codigo_municipio_ibge, api_key_hash, plan, monthly_note_limit, active, webhook_url,
        p_tot_trib_sn, ambiente)
     values ($1, $2, '3550308', $3, 'pro', $4, $5, $6, $7, $8)
     returning id`,
    [
      cnpj,
      `Tenant de teste ${cnpj}`,
      hashApiKey(apiKey),
      options.monthlyNoteLimit ?? 5000,
      options.active ?? true,
      webhookUrl,
      options.pTotTribSn === undefined ? '6.00' : options.pTotTribSn,
      options.ambiente ?? 'producao_restrita',
    ],
  )
  const id = rows[0].id

  const serie = options.serie === undefined ? '1' : options.serie
  if (serie !== null) {
    await db.query('insert into nofiscal.fiscal_dps_series (tenant_id, serie, next_number) values ($1, $2, $3)', [
      id,
      serie,
      options.nextNumber ?? 1,
    ])
  }

  let certificado: Certificado | null = null
  const notAfter = options.notAfter === undefined ? new Date(Date.now() + 365 * 24 * 3600 * 1000) : options.notAfter
  if (notAfter !== null) {
    certificado = options.certificado ?? {
      pfxBase64: `TESTPFX${randomBytes(96).toString('base64')}`,
      password: `senha-${randomBytes(9).toString('hex')}`,
    }
    await db.query('select nofiscal.upsert_certificate($1, $2, $3, $4, $5)', [
      id,
      certificado.pfxBase64,
      certificado.password,
      `CN=TENANT TESTE:${cnpj}`,
      notAfter,
    ])
  }

  let webhookSecret: string | null = null
  if (options.withWebhookSecret) {
    webhookSecret = randomBytes(32).toString('hex')
    await db.query('select nofiscal.set_webhook_secret($1, $2)', [id, webhookSecret])
  }

  return { id, cnpj, apiKey, serie, certificado, webhookSecret, webhookUrl }
}

export async function replaceTestCertificate(db: Db, tenant: TestTenant, notAfter: Date): Promise<Certificado> {
  const certificado = {
    pfxBase64: `TESTPFX${randomBytes(96).toString('base64')}`,
    password: `senha-${randomBytes(9).toString('hex')}`,
  }
  await db.query('select nofiscal.upsert_certificate($1, $2, $3, $4, $5)', [
    tenant.id,
    certificado.pfxBase64,
    certificado.password,
    `CN=TENANT TESTE:${tenant.cnpj}`,
    notAfter,
  ])
  tenant.certificado = certificado
  return certificado
}

export async function dropTestTenant(db: Db, tenantId: string): Promise<void> {
  const vaultIds = await db.query<{ vault_id: string }>(
    `select vault_secret_id as vault_id from nofiscal.fiscal_certificates where tenant_id = $1
     union all
     select webhook_secret_vault_id from nofiscal.fiscal_tenants where id = $1 and webhook_secret_vault_id is not null`,
    [tenantId],
  )
  await db.query(
    'delete from nofiscal.fiscal_invoice_events where invoice_id in (select id from nofiscal.fiscal_invoices where tenant_id = $1)',
    [tenantId],
  )
  await db.query('delete from nofiscal.fiscal_invoices where tenant_id = $1', [tenantId])
  await db.query('delete from nofiscal.fiscal_dps_series where tenant_id = $1', [tenantId])
  await db.query('delete from nofiscal.fiscal_certificates where tenant_id = $1', [tenantId])
  await db.query('delete from nofiscal.fiscal_tenants where id = $1', [tenantId])
  const ids = vaultIds.rows.map((row) => row.vault_id)
  if (ids.length) await db.query('delete from vault.secrets where id = any($1::uuid[])', [ids])
}

export const validPayload = () => ({
  tomador: { cpf: '12345678909', nome: 'Paciente de Teste' },
  servico: { codigo_servico_nacional: '040101', descricao: 'Consulta médica por telemedicina' },
  valor: '42.90',
})

export async function insertQueuedInvoice(db: Db, tenantId: string, externalId = `venda-${randomBytes(6).toString('hex')}`) {
  const { rows } = await db.query<{ id: string }>(
    `insert into nofiscal.fiscal_invoices (tenant_id, external_id, payload) values ($1, $2, $3::jsonb) returning id`,
    [tenantId, externalId, JSON.stringify(validPayload())],
  )
  return { id: rows[0].id, externalId }
}

export type InvoiceRow = {
  id: string
  status: string
  attempts: number
  dps_serie: string | null
  dps_numero: string | null
  id_dps: string | null
  chave_acesso: string | null
  xml_dps: string | null
  xml_nfse: string | null
  payload: unknown
  last_error_code: string | null
  last_error: string | null
  issued_at: Date | null
  next_attempt_at: Date | null
}

export async function readInvoice(db: Db, id: string): Promise<InvoiceRow> {
  const { rows } = await db.query<InvoiceRow>('select * from nofiscal.fiscal_invoices where id = $1', [id])
  return rows[0]
}

export type SefinCall =
  | { op: 'emitir'; invoiceId: string; idDps: string; certificado: Certificado }
  | { op: 'consultar'; idDps: string; certificado: Certificado }
  | { op: 'cancelar'; chaveAcesso: string }
  | { op: 'consultarCancelamento'; chaveAcesso: string }

export type SefinScript = {
  emitir?: (input: { tenant: SefinTenant; invoice: SefinInvoice; certificado: Certificado }) => EmitirResultado | Promise<EmitirResultado>
  consultar?: (input: { idDps: string }) => ConsultaResultado | Promise<ConsultaResultado>
  cancelar?: () => CancelarResultado | Promise<CancelarResultado>
  consultarCancelamento?: () => ConsultaCancelamentoResultado | Promise<ConsultaCancelamentoResultado>
}

/** Dublê da Sefin: registra as chamadas, na ordem, e responde o que o teste mandar. */
export function sefinDouble(script: SefinScript = {}): { client: SefinClient; calls: SefinCall[] } {
  const calls: SefinCall[] = []
  const client: SefinClient = {
    idDps: ({ tenant, serie, numero }) => `DPSTESTE-${tenant.id}-${serie}-${numero}`,
    async emitir(input) {
      calls.push({ op: 'emitir', invoiceId: input.invoice.id, idDps: input.invoice.id_dps, certificado: input.certificado })
      if (script.emitir) return script.emitir(input)
      return {
        kind: 'authorized',
        chaveAcesso: `CHAVE-${input.invoice.id_dps}`,
        xmlDps: `<DPS Id="${input.invoice.id_dps}"/>`,
        xmlNfse: `<NFSe chave="CHAVE-${input.invoice.id_dps}"/>`,
      }
    },
    async consultarPorIdDps(input) {
      calls.push({ op: 'consultar', idDps: input.idDps, certificado: input.certificado })
      if (script.consultar) return script.consultar({ idDps: input.idDps })
      return { kind: 'not_found' }
    },
    async cancelar(input) {
      calls.push({ op: 'cancelar', chaveAcesso: input.chaveAcesso })
      if (script.cancelar) return script.cancelar()
      return { kind: 'unavailable', reason: 'cancelamento não roteirizado no dublê' }
    },
    async consultarCancelamento(input) {
      calls.push({ op: 'consultarCancelamento', chaveAcesso: input.chaveAcesso })
      if (script.consultarCancelamento) return script.consultarCancelamento()
      return { kind: 'not_found' }
    },
  }
  return { client, calls }
}

export const minutes = (base: Date, n: number) => new Date(base.getTime() + n * 60_000)
