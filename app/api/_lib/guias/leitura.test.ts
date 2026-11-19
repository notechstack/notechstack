// Leitura das guias (critérios 9 a 11): PDFs sintéticos gerados no teste (sem dado real), cada tipo, PDF sem texto,
// CNPJ que não casa e valor divergente do código de barras. A IA de reserva roda contra um dublê local da Anthropic.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clienteClaude } from '../ia/claude.js'
import { iniciarDubleIa, type DubleIa, type RespostaIa } from '../../_tests/anthropic-fake.js'
import { cnpjDe, gerarGuiaPdf, gerarPdfSemTexto } from '../../_tests/guias-pdf.js'
import {
  fatorDaData,
  lerLinha,
  lerLinhaArrecadacao,
  lerLinhaBoleto,
  montarArrecadacao,
  montarBoleto,
  vencimentoDoFator,
} from './codigos.js'
import { camposDaIa, leitorGuiaClaude } from './leitor-ia.js'
import { lerGuia, lerGuiaPorRegra } from './leitura.js'
import { textoDoPdf } from './texto-pdf.js'

const CLIENTE = cnpjDe('112223330001')
const ESCRITORIO = cnpjDe('933333330001')
const HOJE = new Date('2026-11-19T12:00:00Z')

describe('códigos de barras', () => {
  it('fator de vencimento: 1000 é 22/02/2025 (recomeço) e o ciclo antigo vale para datas antigas', () => {
    expect(vencimentoDoFator(1000, HOJE)).toBe('2025-02-22')
    expect(fatorDaData('2026-12-20')).toBe(1000 + 666)
    expect(vencimentoDoFator(1666, HOJE)).toBe('2026-12-20')
    // 9999 do ciclo antigo = 21/02/2025, perto de uma referência de 2025.
    expect(vencimentoDoFator(9999, new Date('2025-02-01T00:00:00Z'))).toBe('2025-02-21')
  })

  it('boleto: monta e lê a linha de 47 dígitos com valor e vencimento; DV errado é recusado', () => {
    const { linha, codigoBarras } = montarBoleto({ vencimento: '2026-12-10', valorCentavos: 35000 })
    expect(linha).toHaveLength(47)
    const lido = lerLinhaBoleto(linha, HOJE)
    expect(lido).toMatchObject({ tipo: 'boleto', codigoBarras, valorCentavos: 35000, vencimento: '2026-12-10' })
    const errada = linha.slice(0, 9) + String((Number(linha[9]) + 1) % 10) + linha.slice(10)
    expect(lerLinhaBoleto(errada, HOJE)).toBeNull()
  })

  it('arrecadação (começa com 8): módulo 10 (id 6) e módulo 11 (id 8), valor em centavos', () => {
    for (const identificador of ['6', '8'] as const) {
      const { linha } = montarArrecadacao({ valorCentavos: 123456, identificador })
      expect(linha).toHaveLength(48)
      expect(linha[0]).toBe('8')
      expect(lerLinhaArrecadacao(linha)).toMatchObject({ tipo: 'arrecadacao', valorCentavos: 123456 })
      const errada = linha.slice(0, 20) + String((Number(linha[20]) + 3) % 10) + linha.slice(21)
      expect(lerLinha(errada)).toBeNull()
    }
  })
})

describe('leitura por regra (PDF sintético → texto → campos)', () => {
  const casos = [
    { tipo: 'das' as const, esperado: 'das' },
    { tipo: 'das_mei' as const, esperado: 'das_mei' },
    { tipo: 'darf' as const, esperado: 'darf' },
    { tipo: 'dctfweb' as const, esperado: 'dctfweb' },
    { tipo: 'arrecadacao' as const, esperado: 'iss' },
  ]
  for (const caso of casos) {
    it(`${caso.tipo}: tipo, CNPJ, competência, valor, vencimento e linha digitável`, async () => {
      const g = await gerarGuiaPdf({ tipo: caso.tipo, cnpj: CLIENTE, competencia: '2026-11', vencimento: '2026-12-20', valorCentavos: 123456 })
      const leitura = await lerGuia(g.pdf, { texto: textoDoPdf }, { hoje: HOJE })
      expect(leitura.campos).toEqual({
        tipo: caso.esperado,
        documento: CLIENTE,
        competencia: '2026-11-01',
        valor_centavos: 123456,
        vencimento: '2026-12-20',
        linha_digitavel: g.linha,
      })
      expect(leitura.faltando).toEqual([])
      expect(leitura.valor_divergente).toBe(false)
      expect(leitura.valor_codigo_barras).toBe(123456)
      expect(leitura.origem.valor_centavos).toBe('regra')
      expect(leitura.ia).toBe(false)
    })
  }

  it('boleto de honorários: o CNPJ é o do pagador (nunca o do escritório) e o valor confere com a linha', async () => {
    const g = await gerarGuiaPdf({ tipo: 'boleto', cnpj: CLIENTE, beneficiario: ESCRITORIO, competencia: '2026-11', vencimento: '2026-12-10', valorCentavos: 35000 })
    const leitura = await lerGuia(g.pdf, { texto: textoDoPdf }, { hoje: HOJE, excluir: [ESCRITORIO] })
    expect(leitura.campos).toEqual({
      tipo: 'honorario',
      documento: CLIENTE,
      competencia: '2026-11-01',
      valor_centavos: 35000,
      vencimento: '2026-12-10',
      linha_digitavel: g.linha,
    })
    expect(leitura.valor_divergente).toBe(false)
  })

  it('valor do texto divergente do código de barras: marca a divergência e guarda os dois', async () => {
    const g = await gerarGuiaPdf({ tipo: 'das', cnpj: CLIENTE, vencimento: '2026-12-20', valorCentavos: 123456, valorNoTexto: 123400 })
    const leitura = await lerGuia(g.pdf, { texto: textoDoPdf }, { hoje: HOJE })
    expect(leitura.valor_divergente).toBe(true)
    expect(leitura.campos.valor_centavos).toBe(123400)
    expect(leitura.valor_codigo_barras).toBe(123456)
  })

  it('sem o valor escrito, o valor sai do código de barras', async () => {
    const g = await gerarGuiaPdf({ tipo: 'darf', cnpj: CLIENTE, vencimento: '2026-12-19', valorCentavos: 98700, semValorNoTexto: true })
    const leitura = await lerGuia(g.pdf, { texto: textoDoPdf }, { hoje: HOJE })
    expect(leitura.campos.valor_centavos).toBe(98700)
    expect(leitura.origem.valor_centavos).toBe('codigo_barras')
    expect(leitura.faltando).toEqual([])
  })

  it('CNPJ que não casa com nenhum contato: a leitura devolve o CNPJ lido (o casamento é no banco)', async () => {
    const outro = cnpjDe('555666770001')
    const g = await gerarGuiaPdf({ tipo: 'das', cnpj: outro, vencimento: '2026-12-20', valorCentavos: 5000 })
    const leitura = await lerGuia(g.pdf, { texto: textoDoPdf }, { hoje: HOJE })
    expect(leitura.campos.documento).toBe(outro)
    expect(leitura.campos.documento).not.toBe(CLIENTE)
  })

  it('texto sem nada de guia: tudo faltando', () => {
    const leitura = lerGuiaPorRegra('Relatório interno qualquer, sem guia nenhuma, página 1 de 1.')
    expect(leitura.campos.tipo).toBeNull()
    expect(leitura.faltando).toEqual(['tipo', 'documento', 'competencia', 'valor_centavos', 'vencimento', 'linha_digitavel'])
  })
})

describe('IA de reserva (Haiku, saída estruturada)', () => {
  let duble: DubleIa
  let resposta: RespostaIa = { json: {} }
  beforeAll(async () => {
    duble = await iniciarDubleIa(() => resposta)
  })
  afterAll(() => duble.fechar())
  const ia = () => ({ cliente: clienteClaude({ apiKey: 'sk-teste', baseURL: duble.url }), modelo: 'claude-haiku-4-5-20251001' })

  it('PDF sem texto (imagem): a IA lê; os campos passam pelas regras (DV, data, documento)', async () => {
    const { linha } = montarArrecadacao({ valorCentavos: 76500 })
    resposta = {
      json: { e_guia: true, tipo: 'das_mei', documento: CLIENTE, competencia: '2026-11', vencimento: '2026-12-20', valor: '765.00', linha_digitavel: linha },
    }
    const antes = duble.chamadas.length
    const pdf = await gerarPdfSemTexto()
    expect(await textoDoPdf(pdf)).toBe('')
    const leitura = await lerGuia(pdf, { texto: textoDoPdf, ia: leitorGuiaClaude(ia()) }, { hoje: HOJE })
    expect(duble.chamadas.length).toBe(antes + 1)
    const chamada = duble.chamadas.at(-1)!
    expect(chamada.corpo.model).toBe('claude-haiku-4-5-20251001')
    expect(chamada.corpo.output_config?.format?.type).toBe('json_schema')
    expect(JSON.stringify(chamada.corpo.messages)).toContain('application/pdf')
    expect(leitura.ia).toBe(true)
    expect(leitura.com_texto).toBe(false)
    expect(leitura.campos).toEqual({
      tipo: 'das_mei', documento: CLIENTE, competencia: '2026-11-01', valor_centavos: 76500, vencimento: '2026-12-20', linha_digitavel: linha,
    })
    expect(leitura.origem).toMatchObject({ tipo: 'ia', linha_digitavel: 'ia' })
  })

  it('guia completa pela regra não chama a IA', async () => {
    const antes = duble.chamadas.length
    const g = await gerarGuiaPdf({ tipo: 'das', cnpj: CLIENTE, vencimento: '2026-12-20', valorCentavos: 1000 })
    await lerGuia(g.pdf, { texto: textoDoPdf, ia: leitorGuiaClaude(ia()) }, { hoje: HOJE })
    expect(duble.chamadas.length).toBe(antes)
  })

  it('a IA só preenche o que faltou: o que a regra leu fica', async () => {
    resposta = { json: { e_guia: true, tipo: 'darf', documento: cnpjDe('777888990001'), competencia: '2026-10', vencimento: '2026-12-31', valor: '1.00', linha_digitavel: null } }
    const leitura = await lerGuia(
      new Uint8Array([1]),
      { texto: async () => 'Documento de Arrecadação do Simples Nacional CNPJ ' + CLIENTE, ia: leitorGuiaClaude(ia()) },
      { hoje: HOJE },
    )
    expect(leitura.campos.tipo).toBe('das')
    expect(leitura.campos.documento).toBe(CLIENTE)
    expect(leitura.campos.vencimento).toBe('2026-12-31')
    expect(leitura.origem.vencimento).toBe('ia')
    expect(leitura.faltando).toEqual(['linha_digitavel'])
  })

  it('o que a IA inventa fora da regra vira null (linha com DV errado, CNPJ inválido, data impossível)', () => {
    expect(
      camposDaIa({ e_guia: true, tipo: 'xyz', documento: '11111111111111', competencia: '2026-13', vencimento: '2026-02-30', valor: 'abc', linha_digitavel: '8'.repeat(48) }),
    ).toEqual({})
    expect(camposDaIa({ e_guia: false, tipo: 'das' })).toEqual({})
  })

  it('IA fora do ar: a leitura volta com o que a regra leu e o motivo', async () => {
    resposta = { status: 529, erro: 'overloaded' }
    const leitura = await lerGuia(await gerarPdfSemTexto(), { texto: textoDoPdf, ia: leitorGuiaClaude({ ...ia(), cliente: clienteClaude({ apiKey: 'x', baseURL: duble.url }) }) }, { hoje: HOJE })
    expect(leitura.ia).toBe(false)
    expect(leitura.ia_erro).toBeTruthy()
    expect(leitura.faltando.length).toBe(6)
  })
})
