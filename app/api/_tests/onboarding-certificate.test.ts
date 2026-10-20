// POST e DELETE /api/v1/onboarding/certificate, chamados pela função exportada em
// api/v1/onboarding/certificate.ts com Request HTTP. Checks C6, C7, C8 e C10 de
// .checks/agente-fiscal-whatsapp.md. O banco é o local, com o papel nofiscal_onboarding;
// a sessão é conferida num servidor local que faz o papel do Supabase Auth (`/auth/v1/user`).
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import forge from 'node-forge'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { closeSharedDb } from '../_lib/db.js'
import { runEmission } from '../_lib/emission.js'
import {
  allowTestUserToAssume,
  createAuthUser,
  createSelfServiceTenant,
  dropAuthUser,
  dropSelfServiceTenant,
  openRoleDb,
  roleDatabaseUrl,
  type SelfServiceTenant,
} from './agente-fixtures.js'
import { makeTestCertificate, type TestCertificate } from './certs.js'
import { insertQueuedInvoice, openTestDb, readInvoice, sefinDouble } from './fixtures.js'

const ANON_KEY = 'anon-de-teste'
const authCalls: { apikey: string | undefined; authorization: string | undefined }[] = []
const auth: Server = createServer((req, res) => {
  authCalls.push({ apikey: req.headers.apikey as string | undefined, authorization: req.headers.authorization })
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
process.env.NOFISCAL_ONBOARDING_DATABASE_URL = roleDatabaseUrl('nofiscal_onboarding')
const { default: entry } = await import('../v1/onboarding/certificate.js')

const URL_ROTA = 'https://app.notechstack.com.br/api/v1/onboarding/certificate'
const admin = openTestDb()
const tenants: SelfServiceTenant[] = []
const users: string[] = []

type Corpo = { subject?: string; not_after?: string; error?: { code: string; message: string } }

const token = (userId: string) => `token-${userId}`
const pfxBytes = (cert: TestCertificate) => Buffer.from(cert.certificado.pfxBase64, 'base64')

function enviar(
  sessao: string | null,
  campos: { tenantId?: string; pfx?: Uint8Array; senha?: string },
): Promise<Response> {
  const form = new FormData()
  if (campos.tenantId !== undefined) form.set('tenant_id', campos.tenantId)
  if (campos.pfx !== undefined) {
    form.set('pfx', new Blob([new Uint8Array(campos.pfx)], { type: 'application/x-pkcs12' }), 'a1.pfx')
  }
  if (campos.senha !== undefined) form.set('senha', campos.senha)
  const headers: Record<string, string> = {}
  if (sessao) headers.authorization = `Bearer ${sessao}`
  return entry.fetch(new Request(URL_ROTA, { method: 'POST', headers, body: form }))
}

function apagar(sessao: string | null, tenantId: string): Promise<Response> {
  const headers: Record<string, string> = {}
  if (sessao) headers.authorization = `Bearer ${sessao}`
  return entry.fetch(new Request(`${URL_ROTA}?tenant_id=${tenantId}`, { method: 'DELETE', headers }))
}

async function novoTenant() {
  const s = await createSelfServiceTenant(admin.db, { notAfter: null })
  tenants.push(s)
  return s
}

const certificadoDe = (s: SelfServiceTenant, notAfter?: Date) =>
  makeTestCertificate({ commonName: `EMPRESA TESTE:${s.tenant.cnpj}`, notAfter })

async function linhaDoCertificado(tenantId: string) {
  const { rows } = await admin.db.query<{ vault_secret_id: string; subject: string; not_after: Date }>(
    'select vault_secret_id, subject, not_after from nofiscal.fiscal_certificates where tenant_id = $1',
    [tenantId],
  )
  return rows[0]
}

async function segredosDoTenant(tenantId: string): Promise<number> {
  const { rows } = await admin.db.query<{ n: number }>('select count(*)::int as n from vault.secrets where name = $1', [
    `nofiscal_cert_${tenantId}`,
  ])
  return rows[0].n
}

beforeAll(async () => {
  await allowTestUserToAssume(admin.db, 'nofiscal_onboarding')
  // A URL entregue à rota entra mesmo como nofiscal_onboarding, que não lê as tabelas.
  const papel = openRoleDb('nofiscal_onboarding')
  try {
    const { rows } = await papel.db.query<{ papel: string }>('select current_user as papel')
    expect(rows[0].papel).toBe('nofiscal_onboarding')
    await expect(papel.db.query('select 1 from nofiscal.fiscal_certificates')).rejects.toThrow(/permission denied/)
  } finally {
    await papel.pool.end()
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  for (const s of tenants) await dropSelfServiceTenant(admin.db, s)
  for (const id of users) await dropAuthUser(admin.db, id)
  await closeSharedDb()
  await admin.pool.end()
  await new Promise<void>((resolve) => auth.close(() => resolve()))
})

describe('POST /api/v1/onboarding/certificate', () => {
  it('201 grava no cofre', async () => {
    const s = await novoTenant()
    const cert = certificadoDe(s)
    const res = await enviar(token(s.ownerUserId), {
      tenantId: s.tenant.id,
      pfx: pfxBytes(cert),
      senha: cert.certificado.password,
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Corpo
    const notAfter = forge.pki.certificateFromPem(cert.certPem).validity.notAfter
    expect(body).toEqual({ subject: expect.stringContaining(`EMPRESA TESTE:${s.tenant.cnpj}`), not_after: notAfter.toISOString() })

    // A sessão foi conferida no Supabase Auth com a chave pública.
    expect(authCalls.at(-1)).toEqual({ apikey: ANON_KEY, authorization: `Bearer ${token(s.ownerUserId)}` })

    // Na tabela, só a referência ao Vault, o titular e a validade.
    const linha = await linhaDoCertificado(s.tenant.id)
    expect(linha).toMatchObject({ subject: body.subject, not_after: notAfter })
    expect(JSON.stringify(linha)).not.toContain(cert.certificado.password)
    expect(JSON.stringify(linha)).not.toContain(cert.certificado.pfxBase64.slice(0, 40))

    // O PFX e a senha estão no Supabase Vault, inteiros.
    const { rows } = await admin.db.query<{ decrypted_secret: string }>(
      'select decrypted_secret from vault.decrypted_secrets where id = $1',
      [linha.vault_secret_id],
    )
    expect(JSON.parse(rows[0].decrypted_secret)).toEqual({
      pfx_base64: pfxBytes(cert).toString('base64'),
      password: cert.certificado.password,
    })
  })

  it('422 nos três casos', async () => {
    const s = await novoTenant()
    const valido = certificadoDe(s)
    const vencido = certificadoDe(s, new Date(Date.now() - 60 * 60 * 1000))
    const deOutroCnpj = makeTestCertificate({ commonName: 'OUTRA EMPRESA:99888777000166' })

    const respostas = [
      await enviar(token(s.ownerUserId), { tenantId: s.tenant.id, pfx: pfxBytes(valido), senha: 'senha-errada' }),
      await enviar(token(s.ownerUserId), { tenantId: s.tenant.id, pfx: pfxBytes(vencido), senha: vencido.certificado.password }),
      await enviar(token(s.ownerUserId), {
        tenantId: s.tenant.id,
        pfx: pfxBytes(deOutroCnpj),
        senha: deOutroCnpj.certificado.password,
      }),
    ]
    expect(respostas.map((r) => r.status)).toEqual([422, 422, 422])
    const codigos = await Promise.all(respostas.map(async (r) => ((await r.json()) as Corpo).error?.code))
    expect(codigos).toEqual(['CERT_SENHA_INVALIDA', 'CERT_VENCIDO', 'CERT_CNPJ_DIFERENTE'])
    expect(new Set(codigos).size).toBe(3)

    // Nada gravado: nem a linha, nem o segredo.
    expect(await linhaDoCertificado(s.tenant.id)).toBeUndefined()
    expect(await segredosDoTenant(s.tenant.id)).toBe(0)
  })

  it('401 403 429 e sem vazamento', async () => {
    const logs: string[] = []
    for (const nivel of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, nivel).mockImplementation((...args: unknown[]) => {
        logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
      })
    }
    const corpos: string[] = []
    const ler = async (res: Response) => {
      const texto = await res.text()
      corpos.push(texto)
      return { status: res.status, code: texto ? ((JSON.parse(texto) as Corpo).error?.code ?? null) : null }
    }

    const a = await novoTenant()
    const b = await novoTenant()
    const c = await novoTenant()
    const estranho = await createAuthUser(admin.db)
    users.push(estranho)
    const certA = certificadoDe(a)
    const certC = certificadoDe(c)
    const segredos = [certA.certificado.password, certC.certificado.password, 'senha-errada-1234']
    const campoA = { tenantId: a.tenant.id, pfx: pfxBytes(certA), senha: certA.certificado.password }

    // 401: sem sessão ou com sessão que o Supabase Auth recusa.
    expect(await ler(await enviar(null, campoA))).toEqual({ status: 401, code: 'UNAUTHORIZED' })
    expect(await ler(await enviar('sessao-invalida', campoA))).toEqual({ status: 401, code: 'UNAUTHORIZED' })
    expect(await ler(await apagar(null, a.tenant.id))).toEqual({ status: 401, code: 'UNAUTHORIZED' })

    // 403: dono de outro tenant ou usuário sem empresa.
    expect(await ler(await enviar(token(b.ownerUserId), campoA))).toEqual({ status: 403, code: 'FORBIDDEN' })
    expect(await ler(await enviar(token(estranho), campoA))).toEqual({ status: 403, code: 'FORBIDDEN' })
    expect(await ler(await apagar(token(b.ownerUserId), a.tenant.id))).toEqual({ status: 403, code: 'FORBIDDEN' })
    expect(await linhaDoCertificado(a.tenant.id)).toBeUndefined()
    expect(await segredosDoTenant(a.tenant.id)).toBe(0)

    // 429: a 6ª tentativa na mesma hora, mesmo com o A1 certo.
    for (let i = 0; i < 5; i++) {
      expect(
        await ler(await enviar(token(c.ownerUserId), { tenantId: c.tenant.id, pfx: pfxBytes(certC), senha: 'senha-errada-1234' })),
      ).toEqual({ status: 422, code: 'CERT_SENHA_INVALIDA' })
    }
    expect(
      await ler(
        await enviar(token(c.ownerUserId), { tenantId: c.tenant.id, pfx: pfxBytes(certC), senha: certC.certificado.password }),
      ),
    ).toEqual({ status: 429, code: 'RATE_LIMITED' })
    expect(await linhaDoCertificado(c.tenant.id)).toBeUndefined()

    // As recusas de 403 não travaram o dono de A.
    expect((await ler(await enviar(token(a.ownerUserId), campoA))).status).toBe(201)

    // Nenhum log nem resposta contém o PFX ou a senha.
    expect(logs.length).toBeGreaterThan(0)
    const pfxs = [certA, certC].flatMap((cert) => [cert.certificado.pfxBase64, cert.certificado.pfxBase64.slice(0, 40)])
    for (const texto of [...logs, ...corpos]) {
      for (const segredo of [...segredos, ...pfxs]) expect(texto).not.toContain(segredo)
    }
  })
})

describe('DELETE /api/v1/onboarding/certificate', () => {
  it('apagar o certificado', async () => {
    const s = await novoTenant()
    const outro = await novoTenant()
    const cert = certificadoDe(s)
    const criado = await enviar(token(s.ownerUserId), { tenantId: s.tenant.id, pfx: pfxBytes(cert), senha: cert.certificado.password })
    expect(criado.status).toBe(201)
    const { vault_secret_id: segredo } = await linhaDoCertificado(s.tenant.id)

    // Antes de apagar, com assinatura paga, a emissão real está liberada.
    await admin.db.query(
      `insert into nofiscal.fiscal_subscriptions (tenant_id, plano, com_teste, pagarme_subscription_id, status, aceite_em, aceite_texto)
       values ($1, 'pro', false, $2, 'paga', now(), 'Li e aceito os Termos.')`,
      [s.tenant.id, `sub_teste_${s.tenant.id}`],
    )
    const motivo = async () =>
      (await admin.db.query<{ motivo: string | null }>('select nofiscal.emission_block($1) as motivo', [s.tenant.id])).rows[0]
        .motivo
    expect(await motivo()).toBeNull()

    // Dono de outro tenant não apaga.
    expect((await apagar(token(outro.ownerUserId), s.tenant.id)).status).toBe(403)
    expect(await linhaDoCertificado(s.tenant.id)).toBeDefined()

    const res = await apagar(token(s.ownerUserId), s.tenant.id)
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')

    // O segredo saiu do Supabase Vault e a linha de fiscal_certificates sumiu.
    const { rows: noCofre } = await admin.db.query('select 1 from vault.secrets where id = $1', [segredo])
    expect(noCofre).toHaveLength(0)
    expect(await linhaDoCertificado(s.tenant.id)).toBeUndefined()

    // A emissão real pausa: a nota fica na fila e a Sefin não é chamada.
    expect(await motivo()).toBe('CERT_MISSING')
    const nota = await insertQueuedInvoice(admin.db, s.tenant.id)
    const sefin = sefinDouble()
    await runEmission({ db: admin.db, sefin: sefin.client, now: () => new Date(), tenantId: s.tenant.id })
    expect(sefin.calls).toHaveLength(0)
    expect((await readInvoice(admin.db, nota.id)).status).toBe('queued')

    // Apagar de novo continua 204.
    expect((await apagar(token(s.ownerUserId), s.tenant.id)).status).toBe(204)
  })
})
