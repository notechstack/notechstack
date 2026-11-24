// API pública, chamada pela função exportada em api/v1/nfse.ts com Request HTTP, contra o
// banco local. Checks: C2, C13, C32 (.checks/nfse-automatica-prontia.md).
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeSharedDb } from '../_lib/db.js'
import { createTestTenant, dropTestTenant, openTestDb, TEST_DATABASE_URL, validPayload, type TestTenant } from './fixtures.js'

// Dublê local da BrasilAPI (o endereço do tomador com CNPJ vai em toda nota): só o CNPJ do hospital tem endereço; o
// resto responde 404. Endereço local desliga o espelho e a reserva (consultaCnpjFromEnv): o teste não sai para a rede.
const CNPJ_COM_ENDERECO = '11444777000161'
const receita = createServer((req, res) => {
  const achado = req.url?.endsWith(`/${CNPJ_COM_ENDERECO}`)
  res.writeHead(achado ? 200 : 404, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify(
      achado
        ? { razao_social: 'HOSPITAL ALFA LTDA', codigo_municipio_ibge: 3550308, cep: '1310100', descricao_tipo_de_logradouro: 'AVENIDA', logradouro: 'PAULISTA', numero: '1000', complemento: 'ANDAR 5', bairro: 'BELA VISTA' }
        : { message: 'não encontrado' },
    ),
  )
})
await new Promise<void>((ok) => receita.listen(0, '127.0.0.1', ok))
process.env.CNPJ_API_URL = `http://127.0.0.1:${(receita.address() as AddressInfo).port}`
const ENDERECO_DA_RECEITA = { cMun: '3550308', cep: '01310100', logradouro: 'AVENIDA PAULISTA', numero: '1000', complemento: 'ANDAR 5', bairro: 'BELA VISTA' }

process.env.NOFISCAL_DATABASE_URL = TEST_DATABASE_URL
const { default: entry } = await import('../v1/nfse.js')

type ApiBody = { id: string; status: string; error: { code: string; message: string } } & Record<string, unknown>
const read = async (res: Response) => (await res.json()) as ApiBody

const BASE = 'https://app.notechstack.com.br/api'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const { db, pool } = openTestDb()
const tenants: TestTenant[] = []
let a: TestTenant
let b: TestTenant

const call = (path: string, init: { method?: string; key?: string | null; body?: unknown; rawBody?: string } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (init.key) headers['x-api-key'] = init.key
  return entry.fetch(
    new Request(`${BASE}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
    }),
  )
}

const newSale = (externalId: string) => ({ external_id: externalId, ...validPayload() })

beforeAll(async () => {
  a = await createTestTenant(db)
  b = await createTestTenant(db)
  tenants.push(a, b)
})

afterAll(async () => {
  for (const t of tenants) await dropTestTenant(db, t.id)
  await pool.end()
  await closeSharedDb()
  await new Promise((ok) => receita.close(ok))
})

describe('POST /v1/nfse', () => {
  it('202 queued', async () => {
    const res = await call('/v1/nfse', { method: 'POST', key: a.apiKey, body: newSale('venda-202') })
    expect(res.status).toBe(202)
    const body = await read(res)
    expect(body).toMatchObject({ id: expect.stringMatching(UUID), status: 'queued', external_id: 'venda-202', origem: 'api', avisos: [] })

    const { rows } = await db.query<{ tenant_id: string; external_id: string; status: string; payload: unknown }>(
      'select tenant_id, external_id, status, payload from nofiscal.fiscal_invoices where id = $1',
      [body.id],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ tenant_id: a.id, external_id: 'venda-202', status: 'queued' })
    expect(rows[0].payload).toEqual(validPayload())
  })

  it('idempotente por external_id', async () => {
    const first = await call('/v1/nfse', { method: 'POST', key: a.apiKey, body: newSale('venda-repetida') })
    const second = await call('/v1/nfse', {
      method: 'POST',
      key: a.apiKey,
      body: { ...newSale('venda-repetida'), valor: '99.00' },
    })
    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    const firstBody = await read(first)
    const secondBody = await read(second)
    expect(secondBody.id).toBe(firstBody.id)

    // Ao mesmo tempo (critério 8): as duas respostas trazem o mesmo id.
    const [c1, c2] = await Promise.all([
      call('/v1/nfse', { method: 'POST', key: a.apiKey, body: newSale('venda-simultanea') }),
      call('/v1/nfse', { method: 'POST', key: a.apiKey, body: newSale('venda-simultanea') }),
    ])
    const [b1, b2] = await Promise.all([read(c1), read(c2)])
    expect(c1.status).toBe(202)
    expect(c2.status).toBe(202)
    expect(b2.id).toBe(b1.id)

    const { rows } = await db.query<{ external_id: string; n: string }>(
      `select external_id, count(*) as n from nofiscal.fiscal_invoices
        where tenant_id = $1 and external_id in ('venda-repetida', 'venda-simultanea') group by external_id`,
      [a.id],
    )
    expect(Object.fromEntries(rows.map((r) => [r.external_id, Number(r.n)]))).toEqual({
      'venda-repetida': 1,
      'venda-simultanea': 1,
    })

    // O mesmo external_id em outro tenant é outra venda.
    const other = await call('/v1/nfse', { method: 'POST', key: b.apiKey, body: newSale('venda-repetida') })
    expect((await read(other)).id).not.toBe(firstBody.id)
  })

  // Endereço do tomador (Robson, Bragantina, 24/11/2026): o informado prevalece; CPF só com o informado; CNPJ que a
  // Receita não acha sai sem endereço, com aviso.
  it('tomador.endereco: informado prevalece, CPF com e sem endereço, CNPJ sem endereço na Receita sai com aviso', async () => {
    const payloadDe = async (res: Response) => {
      const { rows } = await db.query<{ payload: { tomador: Record<string, unknown> } }>('select payload from nofiscal.fiscal_invoices where id = $1', [
        (await read(res)).id,
      ])
      return rows[0].payload
    }
    const informado = { cep: '12900-000', logradouro: 'Rua das Flores', numero: '', complemento: 'Sala 2', bairro: 'Centro', municipio_ibge: '3507605' }
    const ENDERECO_INFORMADO = { cMun: '3507605', cep: '12900000', logradouro: 'Rua das Flores', numero: 'S/N', complemento: 'Sala 2', bairro: 'Centro' }

    const cpfSem = await call('/v1/nfse', { method: 'POST', key: a.apiKey, body: newSale('end-cpf-sem') })
    expect(cpfSem.status).toBe(202)
    expect((await payloadDe(cpfSem)).tomador.endereco).toBeUndefined()

    const cpfCom = await call('/v1/nfse', { method: 'POST', key: a.apiKey, body: { ...newSale('end-cpf-com'), tomador: { ...validPayload().tomador, endereco: informado } } })
    expect(cpfCom.status).toBe(202)
    expect((await payloadDe(cpfCom)).tomador.endereco).toEqual(ENDERECO_INFORMADO)

    const pjInformado = { ...newSale('end-pj-informado'), tomador: { cnpj: CNPJ_COM_ENDERECO, nome: 'Hospital Alfa Ltda', endereco: informado } }
    const informadoVale = await call('/v1/nfse', { method: 'POST', key: a.apiKey, body: pjInformado })
    expect((await payloadDe(informadoVale)).tomador.endereco).toEqual(ENDERECO_INFORMADO)

    const naoAchado = await call('/v1/nfse', { method: 'POST', key: a.apiKey, body: { ...newSale('end-pj-sem'), tomador: { cnpj: '11222333000181', nome: 'Empresa X' } } })
    expect(naoAchado.status).toBe(202)
    const corpo = await read(naoAchado.clone())
    expect(corpo.avisos).toEqual([expect.stringContaining('sem o endereço do tomador')])
    expect((await payloadDe(naoAchado)).tomador.endereco).toBeUndefined()

    const incompleto = await call('/v1/nfse', {
      method: 'POST',
      key: a.apiKey,
      body: { ...newSale('end-incompleto'), tomador: { ...validPayload().tomador, endereco: { cep: '12900000' } } },
    })
    expect(incompleto.status).toBe(422)
    expect((await read(incompleto)).error.message).toContain('tomador.endereco')
    const campoExtra = await call('/v1/nfse', {
      method: 'POST',
      key: a.apiKey,
      body: { ...newSale('end-extra'), tomador: { ...validPayload().tomador, endereco: { ...informado, uf: 'SP' } } },
    })
    expect((await read(campoExtra)).error.code).toBe('UNKNOWN_FIELD')
  })

  // Lote B2 do agente fiscal (Landing, "Tomador pessoa jurídica: contrato do motor").
  it('tomador com CPF ou CNPJ, exatamente um', async () => {
    const pj = { ...newSale('venda-pj'), tomador: { cnpj: '11444777000161', nome: 'Hospital Alfa Ltda' } }
    const res = await call('/v1/nfse', { method: 'POST', key: a.apiKey, body: pj })
    expect(res.status).toBe(202)
    const { rows } = await db.query<{ payload: unknown }>('select payload from nofiscal.fiscal_invoices where id = $1', [
      (await read(res)).id,
    ])
    // Sem ISS retido, o endereço da Receita vai também (Bragantina, 24/11/2026), com o zero do CEP.
    expect(rows[0].payload).toEqual({ ...validPayload(), tomador: { cnpj: '11444777000161', nome: 'Hospital Alfa Ltda', endereco: ENDERECO_DA_RECEITA } })

    for (const [externalId, tomador] of [
      ['pj-e-pf', { cpf: '12345678909', cnpj: '11444777000161', nome: 'X' }],
      ['sem-documento', { nome: 'X' }],
      ['cnpj-curto', { cnpj: '1144477700016', nome: 'X' }],
      ['cnpj-com-mascara', { cnpj: '11.444.777/0001-61', nome: 'X' }],
    ] as const) {
      const bad = await call('/v1/nfse', { method: 'POST', key: a.apiKey, body: { ...newSale(externalId), tomador } })
      expect(bad.status).toBe(422)
      expect((await read(bad)).error.code).toBe('VALIDATION_FAILED')
    }
    const extra = await call('/v1/nfse', {
      method: 'POST',
      key: a.apiKey,
      body: { ...newSale('campo-extra'), tomador: { cnpj: '11444777000161', nome: 'X', ie: '123' } },
    })
    expect(extra.status).toBe(422)
    expect((await read(extra)).error.code).toBe('UNKNOWN_FIELD')
  })

  it('recusa corpo inválido', async () => {
    const badJson = await call('/v1/nfse', { method: 'POST', key: a.apiKey, rawBody: '{nope' })
    expect(badJson.status).toBe(400)
    expect(await read(badJson)).toEqual({ error: { code: 'INVALID_JSON', message: expect.any(String) } })

    const badCpf = await call('/v1/nfse', {
      method: 'POST',
      key: a.apiKey,
      body: { ...newSale('cpf-ruim'), tomador: { cpf: '123', nome: 'X' } },
    })
    expect(badCpf.status).toBe(422)
    expect((await read(badCpf)).error.code).toBe('VALIDATION_FAILED')
  })
})

describe('autenticação e isolamento por tenant', () => {
  it('401 e 404', async () => {
    const created = await call('/v1/nfse', { method: 'POST', key: b.apiKey, body: newSale('venda-de-b') })
    const idB = (await read(created)).id as string

    for (const [path, method] of [
      ['/v1/nfse', 'POST'],
      [`/v1/nfse/${idB}`, 'GET'],
      [`/v1/nfse/${idB}/cancel`, 'POST'],
      [`/v1/nfse/${idB}/pdf`, 'GET'],
    ] as const) {
      const missing = await call(path, { method, key: null, body: method === 'POST' ? newSale('sem-chave') : undefined })
      expect(missing.status, `${method} ${path} sem chave`).toBe(401)
      expect((await read(missing)).error.code).toBe('UNAUTHORIZED')

      const invalid = await call(path, { method, key: 'nfk_chave-invalida', body: method === 'POST' ? newSale('chave-ruim') : undefined })
      expect(invalid.status, `${method} ${path} chave inválida`).toBe(401)
      expect((await read(invalid)).error.code).toBe('UNAUTHORIZED')
    }

    // Chave válida de A, nota de B: 404, nas três rotas por id e nas duas formas de URL.
    for (const [path, method] of [
      [`/v1/nfse/${idB}`, 'GET'],
      [`/v1/nfse/${idB}/cancel`, 'POST'],
      [`/v1/nfse/${idB}/pdf`, 'GET'],
      [`/v1/nfse?id=${idB}`, 'GET'],
      [`/v1/nfse?id=${idB}&acao=pdf`, 'GET'],
    ] as const) {
      const res = await call(path, { method, key: a.apiKey })
      expect(res.status, `${method} ${path} de outro tenant`).toBe(404)
      expect((await read(res)).error.code).toBe('NOT_FOUND')
    }

    const notUuid = await call('/v1/nfse/nao-e-uuid', { key: a.apiKey })
    expect(notUuid.status).toBe(404)

    // O dono da nota a enxerga.
    const own = await call(`/v1/nfse/${idB}`, { key: b.apiKey })
    expect(own.status).toBe(200)
    expect(await read(own)).toMatchObject({
      id: idB,
      external_id: 'venda-de-b',
      status: 'queued',
      chave_acesso: null,
      last_error_code: null,
      cnpj_prestador: b.cnpj,
      numero: null,
    })
  })

  it('tenant inativo recebe 403', async () => {
    const inactive = await createTestTenant(db, { active: false })
    tenants.push(inactive)
    const res = await call('/v1/nfse', { method: 'POST', key: inactive.apiKey, body: newSale('inativo') })
    expect(res.status).toBe(403)
    expect((await read(res)).error.code).toBe('TENANT_INACTIVE')
  })

  it('PDF de nota ainda não emitida responde 409', async () => {
    const created = await call('/v1/nfse', { method: 'POST', key: a.apiKey, body: newSale('pdf-cedo') })
    const id = (await read(created)).id
    const res = await call(`/v1/nfse/${id}/pdf`, { key: a.apiKey })
    expect(res.status).toBe(409)
    expect((await read(res)).error.code).toBe('NOT_ISSUED')
  })
})
