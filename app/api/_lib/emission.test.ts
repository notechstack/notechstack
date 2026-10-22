// Motor de emissão contra o banco local, com a Sefin em dublê.
// Checks: C3 (lote 2b, com o cliente Sefin real e o transporte em dublê), C17, C18 (motor),
// C22, C25, C31, C41, C43 (.checks/nfse-automatica-prontia.md).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createTestTenant,
  dropTestTenant,
  insertQueuedInvoice,
  minutes,
  openTestDb,
  readInvoice,
  replaceTestCertificate,
  sefinDouble,
  type TestTenant,
} from '../_tests/fixtures.js'
import { sharedTestCertificate } from '../_tests/certs.js'
import { fakeSefin } from '../_tests/sefin-fake.js'
import { verifySignature } from '../_tests/verify-signature.js'
import { closeSharedDb } from './db.js'
import { runEmission } from './emission.js'
import { handleNfseRequest } from './nfse-routes.js'
import { createSefinClient } from './sefin-client.js'

const { db, pool } = openTestDb()
const tenants: TestTenant[] = []

async function tenant(options: Parameters<typeof createTestTenant>[1] = {}) {
  const created = await createTestTenant(db, options)
  tenants.push(created)
  return created
}

const run = (t: TestTenant, sefin: ReturnType<typeof sefinDouble>, at: Date) =>
  runEmission({ db, sefin: sefin.client, now: () => at, tenantId: t.id })

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  for (const t of tenants) await dropTestTenant(db, t.id)
  await pool.end()
  await closeSharedDb()
})

beforeAll(async () => {
  await db.query('select 1')
})

describe('emissão autorizada (C3)', () => {
  it('chega a issued', async () => {
    const t0 = new Date()
    const cert = sharedTestCertificate()
    const t = await tenant({ certificado: cert.certificado })
    const invoice = await insertQueuedInvoice(db, t.id)
    const sefin = fakeSefin()
    const statuses: string[] = []
    const client = createSefinClient({
      transport: async (request, tls) => {
        statuses.push((await readInvoice(db, invoice.id)).status)
        return sefin.transport(request, tls)
      },
    })

    await runEmission({ db, sefin: client, now: () => t0, tenantId: t.id })

    const row = await readInvoice(db, invoice.id)
    expect(row.status).toBe('issued')
    // Durante a transmissão a nota estava em `sent` (queued → signing → sent → issued).
    expect(statuses).toEqual(['sent'])
    expect(sefin.requests).toHaveLength(1)
    const transmitted = sefin.requests[0].xml!
    expect(row.chave_acesso).toBe(sefin.issued.get(row.id_dps!)!.chave)
    expect(row.chave_acesso).toMatch(/^[0-9]{50}$/)
    expect(row.xml_dps).toBe(transmitted)
    expect(verifySignature(row.xml_dps!, cert.certPem)).toBe(true)
    expect(row.xml_nfse).toBe(sefin.issued.get(row.id_dps!)!.xml)
    expect(row.issued_at).toEqual(t0)
    expect(row.id_dps).toMatch(/^DPS[0-9]{42}$/)
    expect(transmitted).toContain(`Id="${row.id_dps}"`)
  })

  it('sem p_tot_trib_sn a nota fica queued com TRIBUTOS_NOT_CONFIGURED', async () => {
    const t0 = new Date()
    const t = await tenant({ pTotTribSn: null })
    const invoice = await insertQueuedInvoice(db, t.id)
    const sefin = sefinDouble()
    await run(t, sefin, t0)
    const row = await readInvoice(db, invoice.id)
    expect(row.status).toBe('queued')
    expect(row.last_error_code).toBe('TRIBUTOS_NOT_CONFIGURED')
    expect(row.dps_numero).toBeNull()
    expect(sefin.calls).toHaveLength(0)
  })

  it('MEI sem p_tot_trib_sn chega a issued com opSimpNac 2', async () => {
    const t0 = new Date()
    const cert = sharedTestCertificate()
    const t = await tenant({ certificado: cert.certificado, regime: 'mei', pTotTribSn: null })
    const invoice = await insertQueuedInvoice(db, t.id)
    const sefin = fakeSefin()
    await runEmission({ db, sefin: createSefinClient({ transport: sefin.transport }), now: () => t0, tenantId: t.id })
    const row = await readInvoice(db, invoice.id)
    expect(row.status).toBe('issued')
    expect(row.last_error_code).toBeNull()
    expect(row.xml_dps).toContain('<opSimpNac>2</opSimpNac>')
    expect(row.xml_dps).toContain('<indTotTrib>0</indTotTrib>')
    expect(row.xml_dps).not.toContain('pTotTribSN')
  })
})

describe('retentativa com consulta prévia (C17)', () => {
  it('consulta antes de reenviar', async () => {
    const t0 = new Date()

    // Caso 1: a 1ª transmissão dá timeout, mas a nota existe na Sefin → issued sem reenviar.
    const a = await tenant()
    const invoiceA = await insertQueuedInvoice(db, a.id)
    let emitirA = 0
    const sefinA = sefinDouble({
      emitir: () => {
        emitirA++
        return { kind: 'unavailable', reason: 'timeout' }
      },
      consultar: ({ idDps }) => ({ kind: 'found', chaveAcesso: `CHAVE-${idDps}`, xmlNfse: '<NFSe/>' }),
    })
    await run(a, sefinA, t0)
    expect((await readInvoice(db, invoiceA.id)).status).toBe('sent')
    await run(a, sefinA, minutes(t0, 2))

    expect(sefinA.calls.map((c) => c.op)).toEqual(['emitir', 'consultar'])
    expect(emitirA).toBe(1)
    const rowA = await readInvoice(db, invoiceA.id)
    expect(rowA.status).toBe('issued')
    expect(rowA.chave_acesso).toBe(`CHAVE-${rowA.id_dps}`)
    expect(rowA.issued_at).not.toBeNull()

    // Caso 2: 5xx e a nota não existe na Sefin → consulta e só depois reenvia.
    const b = await tenant()
    const invoiceB = await insertQueuedInvoice(db, b.id)
    let first = true
    const sefinB = sefinDouble({
      emitir: ({ invoice }) => {
        if (first) {
          first = false
          return { kind: 'unavailable', reason: 'HTTP 503' }
        }
        return { kind: 'authorized', chaveAcesso: `CHAVE-${invoice.id_dps}`, xmlDps: '<DPS/>', xmlNfse: '<NFSe/>' }
      },
      consultar: () => ({ kind: 'not_found' }),
    })
    await run(b, sefinB, t0)
    await run(b, sefinB, minutes(t0, 2))

    expect(sefinB.calls.map((c) => c.op)).toEqual(['emitir', 'consultar', 'emitir'])
    const rowB = await readInvoice(db, invoiceB.id)
    expect(rowB.status).toBe('issued')
    expect(rowB.attempts).toBe(2)
  })

  it('respeita a espera entre tentativas (1, 5, 15, 60 min)', async () => {
    const t0 = new Date()
    const t = await tenant()
    await insertQueuedInvoice(db, t.id)
    const sefin = sefinDouble({ emitir: () => ({ kind: 'unavailable', reason: 'timeout' }) })
    await run(t, sefin, t0)
    await run(t, sefin, minutes(t0, 0.5))
    expect(sefin.calls.filter((c) => c.op === 'emitir')).toHaveLength(1)
    await run(t, sefin, minutes(t0, 1.1))
    expect(sefin.calls.filter((c) => c.op === 'emitir')).toHaveLength(2)
    await run(t, sefin, minutes(t0, 1.1 + 4))
    expect(sefin.calls.filter((c) => c.op === 'emitir')).toHaveLength(2)
    await run(t, sefin, minutes(t0, 1.1 + 5.1))
    expect(sefin.calls.filter((c) => c.op === 'emitir')).toHaveLength(3)
  })
})

describe('limite de tentativas (C18)', () => {
  it('para na quinta tentativa', async () => {
    const t0 = new Date()
    const t = await tenant()
    const invoice = await insertQueuedInvoice(db, t.id)
    const sefin = sefinDouble({
      emitir: () => ({ kind: 'unavailable', reason: 'timeout' }),
      consultar: () => ({ kind: 'not_found' }),
    })

    let clock = t0
    const seenAttempts: number[] = []
    for (let round = 0; round < 10; round++) {
      await run(t, sefin, clock)
      seenAttempts.push((await readInvoice(db, invoice.id)).attempts)
      clock = minutes(clock, 241)
    }

    expect(Math.max(...seenAttempts)).toBe(5)
    expect(sefin.calls.filter((c) => c.op === 'emitir')).toHaveLength(5)
    const row = await readInvoice(db, invoice.id)
    expect(row.attempts).toBe(5)
    // Tentativas esgotadas: Unresolved 13 da tarefa, valor de "Until answered".
    expect(row.status).toBe('rejected')
    expect(row.last_error_code).toBe('SEFIN_UNAVAILABLE')
  })

  it('a rodada depois da 5ª falha só consulta, e acha a nota emitida', async () => {
    const t0 = new Date()
    const t = await tenant()
    const invoice = await insertQueuedInvoice(db, t.id)
    let consultas = 0
    const sefin = sefinDouble({
      emitir: () => ({ kind: 'unavailable', reason: 'timeout' }),
      consultar: ({ idDps }) => {
        consultas++
        return consultas < 5 ? { kind: 'not_found' } : { kind: 'found', chaveAcesso: `CHAVE-${idDps}`, xmlNfse: '<NFSe/>' }
      },
    })
    let clock = t0
    for (let round = 0; round < 8; round++) {
      await run(t, sefin, clock)
      clock = minutes(clock, 241)
    }
    expect(sefin.calls.filter((c) => c.op === 'emitir')).toHaveLength(5)
    expect((await readInvoice(db, invoice.id)).status).toBe('issued')
  })
})

describe('rejeição de dado (C22)', () => {
  it('rejeição não retenta', async () => {
    const t0 = new Date()
    const t = await tenant()
    const invoice = await insertQueuedInvoice(db, t.id)
    const sefin = sefinDouble({ emitir: () => ({ kind: 'rejected', code: 'E0042', message: 'CPF do tomador inválido' }) })

    await run(t, sefin, t0)
    for (let i = 1; i <= 5; i++) await run(t, sefin, minutes(t0, i * 300))

    const row = await readInvoice(db, invoice.id)
    expect(row.status).toBe('rejected')
    expect(row.last_error_code).toBe('E0042')
    expect(row.attempts).toBe(1)
    expect(sefin.calls).toHaveLength(1)
  })
})

describe('certificado vencido (C25)', () => {
  it('certificado vencido pausa', async () => {
    const t0 = new Date()
    const t = await tenant({ notAfter: minutes(t0, -60) })
    const first = await insertQueuedInvoice(db, t.id)
    const second = await insertQueuedInvoice(db, t.id)
    const sefin = sefinDouble()

    for (let i = 0; i < 3; i++) await run(t, sefin, minutes(t0, i * 10))

    expect(sefin.calls).toHaveLength(0)
    expect((await readInvoice(db, first.id)).status).toBe('queued')
    expect((await readInvoice(db, second.id)).status).toBe('queued')
  })

  it('nota pausada expõe CERT_EXPIRED e sai quando um A1 válido é carregado', async () => {
    const t0 = new Date()
    const t = await tenant({ notAfter: minutes(t0, -60) })
    const invoice = await insertQueuedInvoice(db, t.id)
    const sefin = sefinDouble()

    await run(t, sefin, t0)
    expect((await readInvoice(db, invoice.id)).last_error_code).toBe('CERT_EXPIRED')

    await replaceTestCertificate(db, t, minutes(t0, 60 * 24 * 365))
    await run(t, sefin, minutes(t0, 1))
    const row = await readInvoice(db, invoice.id)
    expect(row.status).toBe('issued')
    expect(row.last_error_code).toBeNull()
  })
})

describe('tenant inativo (C41)', () => {
  it('tenant inativo não transmite', async () => {
    const t0 = new Date()
    const t = await tenant({ active: false })
    const invoice = await insertQueuedInvoice(db, t.id)
    const sefin = sefinDouble()

    for (let i = 0; i < 3; i++) await run(t, sefin, minutes(t0, i * 10))

    expect(sefin.calls).toHaveLength(0)
    const row = await readInvoice(db, invoice.id)
    expect(row.status).toBe('queued')
    expect(row.dps_numero).toBeNull()
  })
})

describe('limite do plano (C43)', () => {
  it('limite do plano não bloqueia', async () => {
    const t0 = new Date()
    const t = await tenant({ monthlyNoteLimit: 1 })
    const sefin = sefinDouble()
    const already = await insertQueuedInvoice(db, t.id)
    await run(t, sefin, t0)
    expect((await readInvoice(db, already.id)).status).toBe('issued')

    const next = await insertQueuedInvoice(db, t.id)
    await run(t, sefin, minutes(t0, 1))

    const row = await readInvoice(db, next.id)
    expect(row.status).toBe('issued')
    expect(sefin.calls.filter((c) => c.op === 'emitir')).toHaveLength(2)
  })
})

describe('custódia do A1 (C31)', () => {
  it('não vaza o certificado', async () => {
    const t0 = new Date()
    const t = await tenant()
    const cert = t.certificado!
    const logs: string[] = []
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
      })
    }

    // Uma biblioteca que despeja as opções (PFX e senha) na mensagem de erro, uma rejeição
    // que ecoa a senha e uma falha de rede que ecoa o PFX.
    const leakyInvoice = await insertQueuedInvoice(db, t.id)
    const rejectedInvoice = await insertQueuedInvoice(db, t.id)
    const sefin = sefinDouble({
      emitir: ({ invoice, certificado }) => {
        if (invoice.id === leakyInvoice.id) {
          throw new Error(`falha no TLS com opções ${JSON.stringify({ pfx: certificado.pfxBase64, passphrase: certificado.password })}`)
        }
        return { kind: 'rejected', code: 'E1234', message: `senha ${certificado.password} recusada` }
      },
      consultar: ({ idDps }) => ({ kind: 'unavailable', reason: `consulta ${idDps} com ${cert.pfxBase64}` }),
    })
    await run(t, sefin, t0)
    await run(t, sefin, minutes(t0, 2))

    // O motor recebeu o certificado certo (o dublê o usou), mas ele não saiu do motor.
    expect(sefin.calls.some((c) => c.op === 'emitir' && c.certificado.password === cert.password)).toBe(true)

    const { rows } = await db.query<Record<string, unknown>>(
      'select payload::text as payload, xml_dps, xml_nfse, last_error, last_error_code from nofiscal.fiscal_invoices where tenant_id = $1',
      [t.id],
    )
    expect(rows).toHaveLength(2)
    const stored = JSON.stringify(rows)
    expect(stored).not.toContain(cert.pfxBase64)
    expect(stored).not.toContain(cert.password)
    expect((await readInvoice(db, rejectedInvoice.id)).status).toBe('rejected')

    const api = await handleNfseRequest(
      new Request(`https://app.notechstack.com.br/api/v1/nfse/${leakyInvoice.id}`, { headers: { 'x-api-key': t.apiKey } }),
      { db },
    )
    const apiBody = await api.text()
    expect(api.status).toBe(200)
    expect(apiBody).not.toContain(cert.pfxBase64)
    expect(apiBody).not.toContain(cert.password)

    expect(logs.length).toBeGreaterThan(0)
    const allLogs = logs.join('\n')
    expect(allLogs).not.toContain(cert.pfxBase64)
    expect(allLogs).not.toContain(cert.password)
  })
})

describe('concorrência entre workers', () => {
  it('duas execuções simultâneas transmitem a nota uma única vez', async () => {
    const t0 = new Date()
    const t = await tenant()
    const invoice = await insertQueuedInvoice(db, t.id)
    const sefin = sefinDouble()
    await Promise.all([run(t, sefin, t0), run(t, sefin, t0)])
    expect(sefin.calls.filter((c) => c.op === 'emitir')).toHaveLength(1)
    expect((await readInvoice(db, invoice.id)).status).toBe('issued')
  })

  it('aloca números consecutivos da série do tenant', async () => {
    const t0 = new Date()
    const t = await tenant({ nextNumber: 731 })
    const a = await insertQueuedInvoice(db, t.id)
    const b = await insertQueuedInvoice(db, t.id)
    await run(t, sefinDouble(), t0)
    const numbers = [(await readInvoice(db, a.id)).dps_numero, (await readInvoice(db, b.id)).dps_numero].map(Number)
    expect(numbers.sort()).toEqual([731, 732])
  })
})
