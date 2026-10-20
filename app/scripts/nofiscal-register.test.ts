// Script local de cadastro do Nó Fiscal. C42 (só o hash da chave, impressa uma vez) e o
// lado do script de C44 (rodar de novo troca o A1 e mantém um único certificado).
// Dependências injetadas; o único banco tocado é o local de desenvolvimento.
import { createHash, randomBytes } from 'node:crypto'
import forge from 'node-forge'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error - script .mjs sem declaração de tipos
import { register } from './nofiscal-register.mjs'

const TEST_DATABASE_URL =
  process.env.NOFISCAL_TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const CONNECTION = 'postgresql://postgres:senha-do-banco@db.exemplo.supabase.co:5432/postgres'
const PFX_PATH = 'C:/certificados/primecare-a1.pfx'
const PFX_PASSWORD = 'senha-do-pfx-123'

function makePfx(options: { cnpj: string; notAfter: Date; password: string; cn?: string }) {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 })
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date(options.notAfter.getTime() - 365 * 24 * 3600 * 1000)
  cert.validity.notAfter = options.notAfter
  const attrs = [
    { name: 'commonName', value: options.cn ?? `PRIMECARE SERVICOS MEDICOS LTDA:${options.cnpj}` },
    { name: 'countryName', value: 'BR' },
  ]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.sign(keys.privateKey, forge.md.sha256.create())
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], options.password, { algorithm: '3des' })
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary')
}

type Query = { text: string; values: unknown[] }

function fakeDb(existingTenantId: string | null) {
  const queries: Query[] = []
  let connectedWith: string | null = null
  let ended = false
  const connect = async (connectionString: string) => {
    connectedWith = connectionString
    return {
      async query(text: string, values: unknown[] = []) {
        queries.push({ text, values })
        if (/from nofiscal\.fiscal_tenants where cnpj/.test(text)) {
          return { rows: existingTenantId ? [{ id: existingTenantId }] : [] }
        }
        if (/insert into nofiscal\.fiscal_tenants/.test(text)) return { rows: [{ id: '11111111-1111-4111-8111-111111111111' }] }
        return { rows: [] }
      },
      async end() {
        ended = true
      },
    }
  }
  return { queries, connect, connected: () => connectedWith, ended: () => ended }
}

function harness(options: { argv: string[]; pfx: Buffer; password?: string; db: ReturnType<typeof fakeDb>; now?: Date }) {
  const printed: string[] = []
  const asked: { question: string; hidden: boolean }[] = []
  const answers = [CONNECTION, PFX_PATH, options.password ?? PFX_PASSWORD]
  const deps = {
    argv: options.argv,
    ask: async (question: string, opts: { hidden?: boolean } = {}) => {
      asked.push({ question, hidden: Boolean(opts.hidden) })
      return answers[asked.length - 1]
    },
    readFile: async (path: string) => {
      if (path !== PFX_PATH) throw new Error(`arquivo inesperado: ${path}`)
      return options.pfx
    },
    connect: options.db.connect,
    randomBytes,
    now: () => options.now ?? new Date('2026-10-20T12:00:00Z'),
    print: (line: string) => printed.push(line),
  }
  return { deps, printed, asked }
}

const CNPJ = '56210013000140'
const NOT_AFTER = new Date('2027-08-15T18:30:00Z')
const creationArgs = [
  `--cnpj=${CNPJ}`,
  '--razao-social=PRIMECARE SERVICOS MEDICOS LTDA',
  '--ibge=3550308',
  '--im=12345678',
  '--webhook-url=https://prontia.example/functions/v1/nfse-callback',
  '--plano=pro',
  '--limite=5000',
  '--serie=900',
  '--proximo-numero=42',
]
const pfx = makePfx({ cnpj: CNPJ, notAfter: NOT_AFTER, password: PFX_PASSWORD })
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1

describe('script de cadastro do Nó Fiscal', () => {
  it('grava só o hash da chave e a imprime uma vez', async () => {
    const db = fakeDb(null)
    const { deps, printed, asked } = harness({ argv: creationArgs, pfx, db })

    const result = await register(deps)
    expect(result.created).toBe(true)

    const output = printed.join('\n')
    const keys = output.match(/nfk_[A-Za-z0-9_-]{43}/g) ?? []
    expect(keys).toHaveLength(1)
    const apiKey = keys[0]
    expect(count(output, apiKey)).toBe(1)

    const tenantInsert = db.queries.find((q) => /insert into nofiscal\.fiscal_tenants/.test(q.text))!
    const hash = createHash('sha256').update(apiKey, 'utf8').digest('hex')
    expect(tenantInsert.values).toContain(hash)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)

    // A chave em texto puro não vai para nenhuma consulta.
    const everyValue = JSON.stringify(db.queries.map((q) => q.values))
    expect(everyValue).not.toContain(apiKey)
    expect(everyValue).not.toContain(apiKey.slice(API_PREFIX_LENGTH))

    // O segredo do callback também aparece uma única vez e vai para o Vault pela função própria.
    const secretLine = printed.find((line) => line.includes('NOFISCAL_WEBHOOK_SECRET='))!
    const webhookSecret = secretLine.split('=')[1]
    expect(webhookSecret).toMatch(/^[0-9a-f]{64}$/)
    expect(count(output, webhookSecret)).toBe(1)
    const setSecret = db.queries.find((q) => /nofiscal\.set_webhook_secret/.test(q.text))!
    expect(setSecret.values).toEqual(['11111111-1111-4111-8111-111111111111', webhookSecret])

    // Conexão, caminho e senha entram sem eco e nunca são impressos.
    expect(asked.every((a) => a.hidden)).toBe(true)
    for (const secret of [CONNECTION, PFX_PATH, PFX_PASSWORD]) expect(output).not.toContain(secret)
    expect(db.connected()).toBe(CONNECTION)
    expect(db.ended()).toBe(true)
    expect(db.queries.map((q) => q.text.trim().split(/\s+/)[0])).toEqual([
      'begin',
      'select',
      'insert',
      'insert',
      'select',
      'select',
      'commit',
    ])
  })

  it('lê subject e not_after do próprio PFX e cria a série com o próximo número informado', async () => {
    const db = fakeDb(null)
    const { deps } = harness({ argv: creationArgs, pfx, db })
    await register(deps)

    const upsert = db.queries.find((q) => /nofiscal\.upsert_certificate/.test(q.text))!
    const [tenantId, pfxBase64, password, subject, notAfter] = upsert.values as [string, string, string, string, Date]
    expect(tenantId).toBe('11111111-1111-4111-8111-111111111111')
    expect(pfxBase64).toBe(pfx.toString('base64'))
    expect(password).toBe(PFX_PASSWORD)
    expect(subject).toContain(`CN=PRIMECARE SERVICOS MEDICOS LTDA:${CNPJ}`)
    expect(notAfter.toISOString()).toBe(NOT_AFTER.toISOString())

    const serie = db.queries.find((q) => /insert into nofiscal\.fiscal_dps_series/.test(q.text))!
    expect(serie.values).toEqual(['11111111-1111-4111-8111-111111111111', '900', '42'])
  })

  it('rodar de novo para o mesmo CNPJ só troca o A1', async () => {
    const db = fakeDb('22222222-2222-4222-8222-222222222222')
    const newPfx = makePfx({ cnpj: CNPJ, notAfter: new Date('2028-01-01T00:00:00Z'), password: PFX_PASSWORD })
    const { deps, printed } = harness({ argv: [`--cnpj=${CNPJ}`], pfx: newPfx, db })

    const result = await register(deps)
    expect(result).toEqual({ tenantId: '22222222-2222-4222-8222-222222222222', created: false })
    expect(db.queries.some((q) => /insert into/.test(q.text))).toBe(false)
    expect(db.queries.some((q) => /set_webhook_secret/.test(q.text))).toBe(false)
    const upserts = db.queries.filter((q) => /nofiscal\.upsert_certificate/.test(q.text))
    expect(upserts).toHaveLength(1)
    expect(upserts[0].values[0]).toBe('22222222-2222-4222-8222-222222222222')
    expect((upserts[0].values[4] as Date).toISOString()).toBe('2028-01-01T00:00:00.000Z')
    expect(printed.join('\n')).not.toMatch(/nfk_|NOFISCAL_WEBHOOK_SECRET/)
  })

  it('senha errada, outro CNPJ ou certificado vencido não chegam ao banco', async () => {
    for (const scenario of [
      { pfx, password: 'senha-errada', message: /não foi possível abrir o PFX/ },
      { pfx: makePfx({ cnpj: '11222333000181', notAfter: NOT_AFTER, password: PFX_PASSWORD }), message: /outro CNPJ/ },
      { pfx: makePfx({ cnpj: CNPJ, notAfter: new Date('2026-01-01T00:00:00Z'), password: PFX_PASSWORD }), message: /venceu/ },
    ]) {
      const db = fakeDb(null)
      const { deps } = harness({ argv: creationArgs, pfx: scenario.pfx, password: scenario.password, db })
      await expect(register(deps)).rejects.toThrow(scenario.message)
      expect(db.connected()).toBeNull()
    }
  })

  it('erro do banco não expõe a conexão, o caminho nem a senha', async () => {
    const { deps } = harness({
      argv: creationArgs,
      pfx,
      db: {
        ...fakeDb(null),
        connect: async (connectionString: string) => {
          throw new Error(`falha ao conectar em ${connectionString} com ${PFX_PASSWORD} lendo ${PFX_PATH}`)
        },
      },
    })
    const error = await register(deps).catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    for (const secret of [CONNECTION, PFX_PATH, PFX_PASSWORD]) expect((error as Error).message).not.toContain(secret)
  })
})

const API_PREFIX_LENGTH = 'nfk_'.length

describe('script de cadastro contra o banco local', () => {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 2 })
  const cnpj = Array.from(randomBytes(14), (b) => String(b % 10)).join('')
  let tenantId: string | null = null

  afterAll(async () => {
    if (tenantId) {
      const vault = await pool.query(
        `select vault_secret_id as id from nofiscal.fiscal_certificates where tenant_id = $1
         union all select webhook_secret_vault_id from nofiscal.fiscal_tenants where id = $1`,
        [tenantId],
      )
      await pool.query('delete from nofiscal.fiscal_dps_series where tenant_id = $1', [tenantId])
      await pool.query('delete from nofiscal.fiscal_certificates where tenant_id = $1', [tenantId])
      await pool.query('delete from nofiscal.fiscal_tenants where id = $1', [tenantId])
      await pool.query('delete from vault.secrets where id = any($1::uuid[])', [vault.rows.map((r) => r.id).filter(Boolean)])
    }
    await pool.end()
  })

  it('rodar de novo troca o A1 e mantém um único certificado por tenant', async () => {
    const connect = async () => {
      const client = new pg.Client({ connectionString: TEST_DATABASE_URL })
      await client.connect()
      return client
    }
    const args = [
      `--cnpj=${cnpj}`,
      '--razao-social=Tenant de teste do script',
      '--ibge=3550308',
      '--webhook-url=https://prontia.example/cb',
      '--plano=inicial',
      '--limite=300',
      '--serie=1',
      '--proximo-numero=10',
    ]
    const firstPfx = makePfx({ cnpj, notAfter: new Date('2027-05-01T00:00:00Z'), password: 'primeira' })
    const secondPfx = makePfx({ cnpj, notAfter: new Date('2028-05-01T00:00:00Z'), password: 'segunda' })

    const run = (pfxBuffer: Buffer, password: string, argv: string[]) => {
      const answers = [TEST_DATABASE_URL, PFX_PATH, password]
      let i = 0
      return register({
        argv,
        ask: async () => answers[i++],
        readFile: async () => pfxBuffer,
        connect,
        randomBytes,
        now: () => new Date('2026-10-20T12:00:00Z'),
        print: () => undefined,
      })
    }

    const first = await run(firstPfx, 'primeira', args)
    tenantId = first.tenantId
    expect(first.created).toBe(true)
    const keyHashBefore = (await pool.query('select api_key_hash from nofiscal.fiscal_tenants where id = $1', [tenantId])).rows[0]

    const second = await run(secondPfx, 'segunda', [`--cnpj=${cnpj}`])
    expect(second).toEqual({ tenantId, created: false })

    const certs = await pool.query('select not_after from nofiscal.fiscal_certificates where tenant_id = $1', [tenantId])
    expect(certs.rows).toHaveLength(1)
    expect((certs.rows[0].not_after as Date).toISOString()).toBe('2028-05-01T00:00:00.000Z')
    const stored = await pool.query('select pfx_base64, password from nofiscal.read_certificate($1)', [tenantId])
    expect(stored.rows).toEqual([{ pfx_base64: secondPfx.toString('base64'), password: 'segunda' }])
    const keyHashAfter = (await pool.query('select api_key_hash from nofiscal.fiscal_tenants where id = $1', [tenantId])).rows[0]
    expect(keyHashAfter).toEqual(keyHashBefore)
    const series = await pool.query('select serie, next_number from nofiscal.fiscal_dps_series where tenant_id = $1', [tenantId])
    expect(series.rows).toEqual([{ serie: '1', next_number: '10' }])
  })
})
