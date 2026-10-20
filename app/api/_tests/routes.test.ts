// C39: nenhuma rota em app/api/ aceita PFX ou senha (critério 31).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { NFSE_ROUTES } from '../_lib/nfse-routes.js'
import { closeSharedDb } from '../_lib/db.js'
import { createTestTenant, dropTestTenant, openTestDb, TEST_DATABASE_URL, validPayload, type TestTenant } from './fixtures.js'

process.env.NOFISCAL_DATABASE_URL = TEST_DATABASE_URL
const { default: entry } = await import('../v1/nfse.js')

type ApiBody = { error: { code: string } }
const read = async (res: Response) => (await res.json()) as ApiBody

const APP_DIR = fileURLToPath(new URL('../../', import.meta.url))
const API_DIR = join(APP_DIR, 'api')
const CERTIFICATE_WORDS = /cert|pfx|p12|senha|password|passphrase/i

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

const posix = (path: string) => relative(APP_DIR, path).split(sep).join('/')

// Mesma regra da Vercel: vira função todo arquivo de código em api/ cujo caminho não tem
// segmento começando com "_" ou "." (fs-detectors, maybeGetApiBuilder).
const functionFiles = () =>
  walk(API_DIR)
    .map(posix)
    .filter((path) => /\.(?:[cm]?[jt]s|tsx?)$/.test(path) && !path.endsWith('.d.ts'))
    .filter((path) => !path.split('/').some((segment) => segment.startsWith('_') || segment.startsWith('.')))
    .sort()

const { db, pool } = openTestDb()
const tenants: TestTenant[] = []

afterAll(async () => {
  for (const t of tenants) await dropTestTenant(db, t.id)
  await pool.end()
  await closeSharedDb()
})

describe('rotas do Nó Fiscal', () => {
  it('nenhuma rota de certificado', async () => {
    // As únicas funções publicadas são a API de notas e o worker.
    expect(functionFiles()).toEqual(['api/internal/nfse-worker.ts', 'api/v1/nfse.ts'])
    for (const path of functionFiles()) expect(path).not.toMatch(CERTIFICATE_WORDS)
    for (const route of NFSE_ROUTES) expect(route.path).not.toMatch(CERTIFICATE_WORDS)

    const vercel = JSON.parse(readFileSync(join(APP_DIR, 'vercel.json'), 'utf8')) as {
      rewrites: { source: string; destination: string }[]
    }
    for (const rewrite of vercel.rewrites.filter((r) => r.destination.startsWith('/api/'))) {
      expect(rewrite.source).not.toMatch(CERTIFICATE_WORDS)
    }

    // Nenhum código publicado chama as funções que gravam o A1 ou o segredo do callback.
    const sources = walk(API_DIR)
      .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts') && !posix(path).startsWith('api/_tests/'))
      .map((path) => readFileSync(path, 'utf8'))
    for (const source of sources) {
      expect(source).not.toMatch(/upsert_certificate|set_webhook_secret/)
    }

    // A única rota que recebe corpo recusa campos de certificado, em qualquer nível.
    const t = await createTestTenant(db)
    tenants.push(t)
    const attempts = [
      { external_id: 'cert-1', ...validPayload(), certificado: { pfx_base64: 'MIIK', password: 'segredo' } },
      { external_id: 'cert-2', ...validPayload(), pfx: 'MIIK', senha: 'segredo' },
      { external_id: 'cert-3', ...validPayload(), tomador: { ...validPayload().tomador, password: 'segredo' } },
    ]
    for (const body of attempts) {
      const res = await entry.fetch(
        new Request('https://app.notechstack.com.br/api/v1/nfse', {
          method: 'POST',
          headers: { 'x-api-key': t.apiKey, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      )
      expect(res.status).toBe(422)
      expect((await read(res)).error.code).toBe('UNKNOWN_FIELD')
    }
    const { rows } = await db.query('select 1 from nofiscal.fiscal_invoices where tenant_id = $1', [t.id])
    expect(rows).toHaveLength(0)
  })
})
