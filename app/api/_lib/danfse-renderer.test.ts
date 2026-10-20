// DANFSe (NT 008 v1.02) gerado do XML da NFS-e, sem banco: casos de borda do renderizador.
import { writeFileSync } from 'node:fs'
import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { pdfTexts } from '../_tests/pdf-text.js'
import { testNfseXml } from '../_tests/sefin-fake.js'
import { renderDanfse } from './danfse-renderer.js'
import { buildDps } from './dps-builder.js'
import type { SefinTenant } from './sefin.js'

const CHAVE = '35503082256210013000140000000000001261100000000010'

const tenant = (overrides: Partial<SefinTenant> = {}): SefinTenant => ({
  id: 't-1',
  cnpj: '56210013000140',
  razao_social: 'PRIMECARE',
  inscricao_municipal: '12345678',
  codigo_municipio_ibge: '3550308',
  regime: 'simples',
  ambiente: 'producao_restrita',
  p_tot_trib_sn: '6.00',
  ...overrides,
})

function nfse(options: { ambiente?: SefinTenant['ambiente']; descricao?: string; nome?: string } = {}) {
  const { xml } = buildDps({
    tenant: tenant({ ambiente: options.ambiente ?? 'producao_restrita' }),
    serie: '1',
    numero: 731,
    payload: {
      tomador: { cpf: '12345678909', nome: options.nome ?? 'Maria da Silva' },
      servico: { codigo_servico_nacional: '040101', descricao: options.descricao ?? 'Consulta médica por telemedicina' },
      valor: '1234.50',
    },
    now: new Date('2026-11-03T13:00:00Z'),
  })
  return testNfseXml({ dpsXml: xml, chave: CHAVE, nNFSe: 1467 })
}

describe('danfse-renderer', () => {
  it('produção: sem a tarja de produção restrita; valores e datas formatados', async () => {
    const texts = pdfTexts(await renderDanfse(nfse({ ambiente: 'producao' })))
    expect(texts).not.toContain('NFS-e SEM VALIDADE JURÍDICA')
    expect(texts).toContain('Tipo de ambiente: Produção')
    expect(texts).toContain('R$ 1.234,50')
    expect(texts).toContain('1467')
    expect(texts).toContain('03/11/2026')
    expect(texts).toContain('03/11/2026 09:59:00')
    expect(texts).toContain('56.210.013/0001-40')
    expect(texts).toContain('12345678')
    expect(texts).toContain('Optante - Microempresa ou Empresa de Pequeno Porte (ME/EPP)')
    expect(texts).toContain('O DESTINATÁRIO É O PRÓPRIO TOMADOR/ADQUIRENTE DA OPERAÇÃO')
    expect(texts.join('\n')).toContain('6,00% do valor do serviço')
  })

  it('descrição longa e caracteres fora da WinAnsi cabem numa página', async () => {
    const pdf = await renderDanfse(
      nfse({ descricao: `${'Consulta de retorno com orientação. '.repeat(50)} 😀 漢字`, nome: 'José 😀 Ñandú' }),
    )
    const doc = await PDFDocument.load(pdf)
    expect(doc.getPageCount()).toBe(1)
    const texts = pdfTexts(pdf)
    expect(texts.some((t) => t.startsWith('José ? Ñandú'))).toBe(true)
  })

  it('recusa XML que não é NFS-e', async () => {
    await expect(renderDanfse('<DPS/>')).rejects.toThrow(/NFS-e/)
    await expect(renderDanfse('não é xml')).rejects.toThrow()
  })

  it.runIf(process.env.NOFISCAL_DANFSE_SAMPLE)('grava um exemplo para inspeção visual', async () => {
    writeFileSync(process.env.NOFISCAL_DANFSE_SAMPLE!, await renderDanfse(nfse(), { cancelada: true }))
  })
})
