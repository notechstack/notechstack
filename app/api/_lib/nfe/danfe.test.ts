import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { pdfTexts } from '../../_tests/pdf-text.js'
import { makeTestCertificate } from '../../_tests/certs.js'
import { signXml } from '../xml-signer.js'
import { modulosCode128C, PADROES, simbolosCode128C, STOP } from './code128.js'
import { formatarChave, lerNfeProc, renderDanfe } from './danfe.js'
import { montarNfe, type NfeInput } from './nfe-builder.js'
import { notaExemplo } from './nfe-fixtures.js'
import { nfeProc } from './sefaz-client.js'

const cert = makeTestCertificate()

function procDe(input: NfeInput) {
  const { xml, chave } = montarNfe(input)
  const assinada = signXml({ xml, signedElement: 'infNFe', keyPem: cert.keyPem, certPem: cert.certPem, profile: 'sha1-c14n' })
  const prot =
    `<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>SP</verAplic><chNFe>${chave}</chNFe>` +
    `<dhRecbto>2026-11-16T12:30:05-03:00</dhRecbto><nProt>135260000012345</nProt><digVal>x</digVal><cStat>100</cStat><xMotivo>Autorizado</xMotivo></infProt></protNFe>`
  return { proc: nfeProc(assinada, prot), chave }
}

describe('Code 128C', () => {
  it('cada padrão soma 11 módulos e é único; a parada soma 13', () => {
    for (const p of PADROES) expect([...p].reduce((s, c) => s + Number(c), 0)).toBe(11)
    expect(new Set(PADROES).size).toBe(PADROES.length)
    expect([...STOP].reduce((s, c) => s + Number(c), 0)).toBe(13)
  })

  it('verificador: (105 + Σ valor × posição) mod 103', () => {
    // "12345678": pares 12, 34, 56, 78 → 105 + 12 + 68 + 168 + 312 = 665; 665 mod 103 = 47
    expect(simbolosCode128C('12345678')).toEqual([105, 12, 34, 56, 78, 47])
  })

  it('chave de 44 dígitos: início, 22 pares, verificador e parada (24 × 6 + 7 elementos)', () => {
    expect(modulosCode128C('3'.repeat(44))).toHaveLength(24 * 6 + 7)
    expect(() => modulosCode128C('123')).toThrow()
  })
})

describe('DANFE', () => {
  it('lê o nfeProc', () => {
    const { proc, chave } = procDe(notaExemplo())
    const d = lerNfeProc(proc)
    expect(d).toMatchObject({ chave, numero: '42', serie: '1', tipo: '1', protocolo: '135260000012345', ambiente: '2' })
    expect(d.itens).toHaveLength(2)
    expect(d.itens[1]).toMatchObject({ cst: '0101', cfop: '5102', quantidade: '2.5000', unitario: '12.345', total: '30.86' })
  })

  it('folha única com os blocos do Anexo II, chave formatada, protocolo e "SEM VALOR FISCAL" em homologação', async () => {
    const { proc, chave } = procDe(notaExemplo())
    const pdf = await renderDanfe(proc)
    const doc = await PDFDocument.load(pdf)
    expect(doc.getPageCount()).toBe(1)
    const textos = pdfTexts(pdf).join('\n')
    for (const esperado of [
      'DANFE',
      'Documento Auxiliar da',
      'Nº 000.000.042',
      'SÉRIE 001',
      'FOLHA 1/1',
      formatarChave(chave),
      '135260000012345 - 16/11/2026 12:30:05',
      'Comercio Exemplo Braganca Ltda',
      'Bragança Paulista - SP - Fone: 1140330000',
      '12.345.678/0001-95',
      'DESTINATÁRIO / REMETENTE',
      'CÁLCULO DO IMPOSTO',
      '89,56',
      'Farinha de trigo 5kg',
      '2,5000',
      '12,345',
      '0101',
      '9 - Sem Ocorrência de Transporte',
      'DADOS ADICIONAIS',
      'SEM VALOR FISCAL',
    ]) {
      expect(textos).toContain(esperado)
    }
  })

  it('produção sem marca; cancelada com marca', async () => {
    const { proc } = procDe(notaExemplo({ ambiente: 'producao' }))
    expect(pdfTexts(await renderDanfe(proc)).join('\n')).not.toContain('SEM VALOR FISCAL')
    expect(pdfTexts(await renderDanfe(proc, { cancelada: true }))).toContain('CANCELADA')
  })

  it('muitos itens continuam nas folhas seguintes, com FOLHA n/N', async () => {
    const base = notaExemplo()
    const itens = Array.from({ length: 120 }, (_, i) => ({ ...base.itens[0], codigo: `P${i + 1}`, descricao: `Produto numero ${i + 1} com descricao razoavelmente longa para quebrar em duas linhas na coluna` }))
    const total = itens.reduce((s, i) => s + i.quantidade * i.valorUnitario, 0)
    const { proc } = procDe(notaExemplo({ itens, pagamentos: [{ forma: '15', valor: total }] }))
    const pdf = await renderDanfe(proc)
    const paginas = (await PDFDocument.load(pdf)).getPageCount()
    expect(paginas).toBeGreaterThan(1)
    const textos = pdfTexts(pdf)
    expect(textos).toContain(`FOLHA ${paginas}/${paginas}`)
    expect(textos).toContain('P1')
    expect(textos).toContain('P120')
  })
})
