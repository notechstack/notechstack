// GET /api/v1/fiscal/nota-pdf (Decision "PDF da nota" de .design/agente-fiscal-escritorio.md), sem banco: sessão e
// banco são dublês, e o DANFSe sai do renderizador de verdade a partir de uma NFS-e montada como nos testes do motor.
import { describe, expect, it, vi } from 'vitest'
import { pdfTexts } from '../_tests/pdf-text.js'
import { testNfseXml } from '../_tests/sefin-fake.js'
import { buildDps } from './dps-builder.js'
import type { Queryable } from './db.js'
import { handleNotaPdf, nomeDoArquivo } from './nota-pdf.js'
import type { SessionVerifier } from './session.js'

const USER = '7d1f2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b'
const OUTRO = '11111111-2222-4333-8444-555555555555'
const NOTA = '0f9e8d7c-6b5a-4c3d-9e2f-1a0b9c8d7e6f'
const CHAVE = '35503082256210013000140000000000001261100000000010'

function nfse() {
  const { xml } = buildDps({
    tenant: {
      id: 't-1', cnpj: '56210013000140', razao_social: 'ESCRITORIO CONTABIL', inscricao_municipal: '12345678',
      codigo_municipio_ibge: '3550308', regime: 'simples', ambiente: 'producao_restrita', p_tot_trib_sn: '6.00',
    },
    serie: '1',
    numero: 42,
    payload: {
      tomador: { cpf: '12345678909', nome: 'Maria da Silva' },
      servico: { codigo_servico_nacional: '170201', descricao: 'Honorários contábeis de outubro' },
      valor: '850.00',
    },
    now: new Date('2026-11-05T13:00:00Z'),
  })
  return testNfseXml({ dpsXml: xml, chave: CHAVE, nNFSe: 1467 })
}

type Linha = { status: string; xml_nfse: string | null; dps_numero: string | number | null; tenant_id: string }

/** Banco falso: uma tabela de notas e a posse por usuário (o que `usuario_pode_tenant` responderia). */
function banco(notas: Record<string, Linha>, posse: Record<string, string[]>) {
  const consultas: { text: string; values: unknown[] }[] = []
  const db: Queryable = {
    async query<R>(text: string, values: unknown[] = []) {
      consultas.push({ text, values })
      const [userId, invoiceId] = values as [string, string]
      const n = notas[invoiceId]
      const rows = n
        ? [{ status: n.status, xml_nfse: n.xml_nfse, dps_numero: n.dps_numero, pode: (posse[userId] ?? []).includes(n.tenant_id) }]
        : []
      return { rows: rows as R[], rowCount: rows.length }
    },
  }
  return { db, consultas }
}

const sessoes: SessionVerifier = {
  async userIdFrom(request) {
    const m = /^Bearer token-(.+)$/.exec(request.headers.get('authorization') ?? '')
    return m ? m[1] : null
  },
}

const pedir = (id: string | null, token: string | null = USER, method = 'GET') =>
  new Request(`https://app.notechstack.com.br/api/v1/fiscal/nota-pdf/${id === null ? '' : `?invoice_id=${id}`}`, {
    method,
    headers: token ? { authorization: `Bearer token-${token}` } : {},
  })

describe('GET /v1/fiscal/nota-pdf', () => {
  const xml = nfse()
  const tabela: Record<string, Linha> = {
    [NOTA]: { status: 'issued', xml_nfse: xml, dps_numero: 42, tenant_id: 'empresa-a' },
    'aaaaaaaa-0000-4000-8000-000000000001': { status: 'cancelled', xml_nfse: xml, dps_numero: 43, tenant_id: 'empresa-a' },
    'aaaaaaaa-0000-4000-8000-000000000002': { status: 'rejected', xml_nfse: null, dps_numero: 44, tenant_id: 'empresa-a' },
    'aaaaaaaa-0000-4000-8000-000000000003': { status: 'queued', xml_nfse: null, dps_numero: null, tenant_id: 'empresa-a' },
    'aaaaaaaa-0000-4000-8000-000000000004': { status: 'issued', xml_nfse: null, dps_numero: 45, tenant_id: 'empresa-a' },
    'aaaaaaaa-0000-4000-8000-000000000005': { status: 'cancel_requested', xml_nfse: xml, dps_numero: 46, tenant_id: 'empresa-a' },
  }
  const posse = { [USER]: ['empresa-a'], [OUTRO]: ['empresa-b'] }

  it('devolve o DANFSe da nota emitida para baixar', async () => {
    const { db, consultas } = banco(tabela, posse)
    const res = await handleNotaPdf(pedir(NOTA), { db, sessions: sessoes })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="nfse-1467.pdf"')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(Buffer.from(bytes.subarray(0, 5)).toString('latin1')).toBe('%PDF-')
    expect(pdfTexts(bytes).join(' ')).toContain('Honorários contábeis de outubro')
    // A posse passa pela função do banco, com o usuário da sessão.
    expect(consultas).toHaveLength(1)
    expect(consultas[0].text).toContain('nofiscal.usuario_pode_tenant($1, i.tenant_id)')
    expect(consultas[0].values).toEqual([USER, NOTA])
  })

  it('nota cancelada sai com a marca de cancelada', async () => {
    const { db } = banco(tabela, posse)
    const render = vi.fn(async () => new Uint8Array([37, 80, 68, 70, 45]))
    const res = await handleNotaPdf(pedir('aaaaaaaa-0000-4000-8000-000000000001'), { db, sessions: sessoes, render })
    expect(res.status).toBe(200)
    expect(render).toHaveBeenCalledWith(xml, { cancelada: true })
    const emitida = await handleNotaPdf(pedir(NOTA), { db, sessions: sessoes, render })
    expect(emitida.status).toBe(200)
    expect(render).toHaveBeenLastCalledWith(xml, { cancelada: false })
  })

  it('401 sem sessão, sem tocar no banco', async () => {
    const { db, consultas } = banco(tabela, posse)
    const res = await handleNotaPdf(pedir(NOTA, null), { db, sessions: sessoes })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'faça login para baixar a nota' } })
    expect(consultas).toHaveLength(0)
  })

  it('404 para nota de outra conta, sem NFS-e, inexistente ou id inválido', async () => {
    const { db } = banco(tabela, posse)
    const render = vi.fn(async () => new Uint8Array())
    const casos: [string | null, string][] = [
      [NOTA, OUTRO], // empresa de outra conta
      ['aaaaaaaa-0000-4000-8000-000000000002', USER], // recusada
      ['aaaaaaaa-0000-4000-8000-000000000003', USER], // na fila
      ['aaaaaaaa-0000-4000-8000-000000000004', USER], // issued sem xml_nfse
      ['aaaaaaaa-0000-4000-8000-000000000005', USER], // cancel_requested: fora da regra da rota
      ['bbbbbbbb-0000-4000-8000-000000000009', USER], // não existe
      ['nao-e-uuid', USER],
      [null, USER],
    ]
    for (const [id, user] of casos) {
      const res = await handleNotaPdf(pedir(id, user), { db, sessions: sessoes, render })
      expect(res.status, `${id} / ${user}`).toBe(404)
      expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'nota não encontrada' } })
    }
    expect(render).not.toHaveBeenCalled()
  })

  it('405 fora do GET e 500 sem detalhe quando o banco falha', async () => {
    const { db } = banco(tabela, posse)
    expect((await handleNotaPdf(pedir(NOTA, USER, 'POST'), { db, sessions: sessoes })).status).toBe(405)
    const quebrado: Queryable = { query: async () => { throw new Error('senha=segredo') } }
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const res = await handleNotaPdf(pedir(NOTA), { db: quebrado, sessions: sessoes })
    expect(res.status).toBe(500)
    expect(log.mock.calls.flat().join(' ')).not.toContain('segredo')
    log.mockRestore()
  })

  it('nome do arquivo: número da NFS-e, senão da DPS, senão o id', () => {
    expect(nomeDoArquivo({ xml_nfse: xml, dps_numero: 42 }, NOTA)).toBe('nfse-1467.pdf')
    expect(nomeDoArquivo({ xml_nfse: '<nao-e-nfse/>', dps_numero: 42 }, NOTA)).toBe('nfse-42.pdf')
    expect(nomeDoArquivo({ xml_nfse: null, dps_numero: null }, NOTA)).toBe(`nfse-${NOTA}.pdf`)
  })
})
