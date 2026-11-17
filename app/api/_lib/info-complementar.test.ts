// Informações complementares da nota (Contabilidade Bragantina, 17/11/2026): normalização para o TSDescInfCompl,
// separação do pedido escrito, `serv/infoCompl/xInfComp` nos dois leiautes (validado nos XSD oficiais), API
// `/v1/nfse`, formulário do painel e DANFSe. Sem banco.
import { DOMParser } from '@xmldom/xmldom'
import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { pdfTexts } from '../_tests/pdf-text.js'
import { testNfseXml } from '../_tests/sefin-fake.js'
import { errosXsd, type PacoteXsd } from '../_tests/xsd.js'
import { payloadDaNota } from './agente/notas.js'
import { renderDanfse } from './danfse-renderer.js'
import { buildDps, DpsInvalidError, type OpcoesDps } from './dps-builder.js'
import { lerInfoComplementar, MAX_INFO_COMPLEMENTAR, normalizarInfoComplementar, separarInfoComplementar } from './info-complementar.js'
import { parseNfseXml } from './nfse-xml.js'
import { lerPedido } from './painel-emissao.js'
import type { SefinTenant } from './sefin.js'
import { parseNewInvoice } from './validation.js'

const NS = 'http://www.sped.fazenda.gov.br/nfse'
const PROD: PacoteXsd = 'producao-v1.01-20260209'
const PR: PacoteXsd = 'producao-restrita-20261020'
const V101: OpcoesDps = { leiaute: 'v1.01', ibscbs: false }
const NT009: OpcoesDps = { leiaute: 'nt009', ibscbs: false }
const now = new Date('2026-11-17T13:00:00Z')

const tenant = (overrides: Partial<SefinTenant> = {}): SefinTenant => ({
  id: 't-1',
  cnpj: '56210013000140',
  razao_social: 'CONTABILIDADE MODELO LTDA',
  inscricao_municipal: null,
  codigo_municipio_ibge: '3550308',
  regime: 'simples',
  ambiente: 'producao',
  p_tot_trib_sn: '6.00',
  ...overrides,
})

const BANCO = 'Dados bancários: Caixa Economica Federal - Agencia: 0001 - Conta Corrente: 00012345-6'
const payload = (extra: Record<string, unknown> = {}) => ({
  tomador: { cnpj: '11222333000181', nome: 'Cliente Tomador SA' },
  servico: { codigo_servico_nacional: '171901', descricao: 'Honorários contábeis realizados no mês 09/2026' },
  valor: '1500.00',
  ...extra,
})
const gerar = (opcoes: OpcoesDps, p: unknown = payload()) => buildDps({ tenant: tenant(), serie: '1', numero: 7, payload: p, now, opcoes }).xml
const filhos = (xml: string, nome: string) => {
  const no = new DOMParser().parseFromString(xml, 'text/xml').getElementsByTagNameNS(NS, nome)[0]
  return no ? Array.from(no.childNodes).map((n) => (n as Element).localName) : []
}
const texto = (xml: string, nome: string) =>
  Array.from(new DOMParser().parseFromString(xml, 'text/xml').getElementsByTagNameNS(NS, nome)).map((n) => n.textContent)

describe('normalização (TSDescInfCompl: 1 a 2.000 caracteres de " " a "ÿ")', () => {
  it('quebra de linha vira " - " (ou espaço depois de ":"), aspas e travessões viram os simples, emoji sai', () => {
    expect(normalizarInfoComplementar('Dados bancários:\nCaixa\r\nAgência 0001\n\n  Conta 123  ')).toBe('Dados bancários: Caixa - Agência 0001 - Conta 123')
    expect(normalizarInfoComplementar('“PIX” – chave… 😀\tok')).toBe('"PIX" - chave... ok')
    expect(normalizarInfoComplementar('  ')).toBeNull()
    expect(normalizarInfoComplementar(undefined)).toBeNull()
    expect(normalizarInfoComplementar(123)).toBeNull()
  })

  it('limite de 2.000 depois de normalizar', () => {
    expect(lerInfoComplementar('a'.repeat(MAX_INFO_COMPLEMENTAR))).toEqual({ ok: true, texto: 'a'.repeat(2000) })
    expect(lerInfoComplementar('a'.repeat(2001))).toEqual({ ok: false, tamanho: 2001 })
    expect(lerInfoComplementar(null)).toEqual({ ok: true, texto: null })
  })
})

describe('pedido escrito: a informação complementar sai do texto da IA', () => {
  it('caso real de 17/11/2026: os dados bancários vão para o campo, e o pedido segue sem eles', () => {
    const pedido = 'Nota para Escritório Modelo, 1.500,00, honorários contábeis realizados no mês 09/2026'
    expect(separarInfoComplementar(`${pedido} - ${BANCO}`)).toEqual({ pedido, info: BANCO })
  })

  it('rótulos "Informações complementares:" e "info compl" saem; "Obs:" e "Chave PIX:" ficam', () => {
    expect(separarInfoComplementar('nota pra Maria, 300. Informações complementares: pedido 4512')).toEqual({ pedido: 'nota pra Maria, 300', info: 'pedido 4512' })
    expect(separarInfoComplementar('nota pra Maria, 300 info compl: contrato 9')).toEqual({ pedido: 'nota pra Maria, 300', info: 'contrato 9' })
    expect(separarInfoComplementar('nota pra Maria, 300, obs: pago em dinheiro')).toEqual({ pedido: 'nota pra Maria, 300', info: 'obs: pago em dinheiro' })
    expect(separarInfoComplementar('nota pra Maria, 300; Chave PIX: 11999990000')).toEqual({ pedido: 'nota pra Maria, 300', info: 'Chave PIX: 11999990000' })
  })

  it('sem marcador, ou só citando as palavras, o texto fica inteiro', () => {
    for (const t of ['nota pra Maria, 300', 'nota pra Banco Caixa, 300, revisão de dados bancários do cliente', 'nota pra Maria, observação clínica, 200']) {
      expect(separarInfoComplementar(t)).toEqual({ pedido: t, info: null })
    }
  })
})

describe('DPS: serv/infoCompl/xInfComp', () => {
  it('sem o campo, a DPS sai igual, byte a byte, nos dois leiautes (ausente, null ou vazio)', () => {
    for (const opcoes of [V101, NT009]) {
      const antes = gerar(opcoes)
      expect(antes).not.toContain('infoCompl')
      expect(gerar(opcoes, payload({ informacoes_complementares: null }))).toBe(antes)
      expect(gerar(opcoes, payload({ informacoes_complementares: ' \n ' }))).toBe(antes)
    }
  })

  it('leiaute de produção (XSD 09/02/2026): infoCompl é o último filho de serv, e a DPS valida', async () => {
    const xml = gerar(V101, payload({ informacoes_complementares: BANCO }))
    expect(filhos(xml, 'serv')).toEqual(['locPrest', 'cServ', 'infoCompl'])
    expect(filhos(xml, 'infoCompl')).toEqual(['xInfComp'])
    expect(texto(xml, 'xInfComp')).toEqual([BANCO])
    expect(await errosXsd(xml, PROD)).toEqual([])
  })

  it('leiaute NT 009 (produção restrita, 20/10/2026): mesma posição, e a DPS valida', async () => {
    const xml = gerar(NT009, payload({ informacoes_complementares: BANCO }))
    expect(filhos(xml, 'serv')).toEqual(['locPrest', 'cServ', 'infoCompl'])
    expect(await errosXsd(xml, PR)).toEqual([])
  })

  it('2.000 caracteres, quebras de linha, aspas e "&" validam; 2.001 é recusado', async () => {
    const longa = `${'Agência 0001 & conta "12345-6"; '.repeat(80)}`.slice(0, 1999) + 'x'
    const xml = gerar(V101, payload({ informacoes_complementares: longa }))
    expect(texto(xml, 'xInfComp')[0]).toHaveLength(2000)
    expect(await errosXsd(xml, PROD)).toEqual([])
    const quebras = gerar(NT009, payload({ informacoes_complementares: 'Banco:\nCaixa\nAg 1\n😀' }))
    expect(texto(quebras, 'xInfComp')).toEqual(['Banco: Caixa - Ag 1'])
    expect(await errosXsd(quebras, PR)).toEqual([])
    expect(() => gerar(V101, payload({ informacoes_complementares: 'a'.repeat(2001) }))).toThrow(DpsInvalidError)
    expect(() => gerar(V101, payload({ informacoes_complementares: 12 }))).toThrow(DpsInvalidError)
  })

  it('o payload do agente e do painel só leva o campo quando há texto', () => {
    const t = { documento: '52998224725', nome: 'Maria', email: null }
    const s = { codigo: '171901', descricao: 'Honorários' }
    expect(payloadDaNota(t, s, '10.00')).not.toHaveProperty('informacoes_complementares')
    expect(payloadDaNota(t, s, '10.00', { informacoes_complementares: null })).not.toHaveProperty('informacoes_complementares')
    expect(payloadDaNota(t, s, '10.00', { informacoes_complementares: BANCO })).toMatchObject({ informacoes_complementares: BANCO })
  })
})

describe('API /v1/nfse: campo opcional informacoes_complementares', () => {
  const corpo = (extra: Record<string, unknown> = {}) => ({
    external_id: 'venda-1',
    tomador: { cpf: '52998224725', nome: 'Maria' },
    servico: { codigo_servico_nacional: '171901', descricao: 'Honorários' },
    valor: '100',
    ...extra,
  })

  it('aceita, normaliza e guarda no payload; ausente ou vazio, o payload é o de antes', () => {
    const ok = parseNewInvoice(corpo({ informacoes_complementares: '  Banco:\nCaixa ' }))
    expect(ok).toMatchObject({ ok: true, value: { payload: { informacoes_complementares: 'Banco: Caixa' } } })
    for (const sem of [corpo(), corpo({ informacoes_complementares: '' }), corpo({ informacoes_complementares: null })]) {
      const r = parseNewInvoice(sem)
      expect(r.ok && r.value.payload).not.toHaveProperty('informacoes_complementares')
    }
  })

  it('recusa acima de 2.000 caracteres e o que não é texto', () => {
    expect(parseNewInvoice(corpo({ informacoes_complementares: 'a'.repeat(2001) }))).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', message: expect.stringContaining('2000') })
    expect(parseNewInvoice(corpo({ informacoes_complementares: 5 }))).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
  })
})

describe('painel: formulário da nota avulsa', () => {
  const empresa = { codigo_servico_nacional: '171901' }
  const corpo = (extra: Record<string, unknown> = {}) => ({
    tenant_id: '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b',
    documento: '529.982.247-25',
    nome: 'Maria',
    valor: '1.500,00',
    descricao: 'Honorários',
    ...extra,
  })

  it('lê o campo opcional e devolve o erro no campo certo acima de 2.000', () => {
    const lido = lerPedido(corpo({ informacoes_complementares: BANCO }), empresa)
    expect(lido).toMatchObject({ ok: true, pedido: { informacoes_complementares: BANCO } })
    expect(lerPedido(corpo(), empresa)).toMatchObject({ ok: true, pedido: { informacoes_complementares: null } })
    expect(lerPedido(corpo({ informacoes_complementares: 'x'.repeat(2001) }), empresa)).toEqual({
      ok: false,
      campo: 'informacoes_complementares',
      mensagem: 'As informações complementares passam de 2.000 caracteres.',
    })
  })
})

describe('DANFSe', () => {
  const nfse = (info: string | null, descricao?: string) => {
    const p = payload({ ...(info ? { informacoes_complementares: info } : {}), ...(descricao ? { servico: { codigo_servico_nacional: '171901', descricao } } : {}) })
    return testNfseXml({ dpsXml: gerar(V101, p), chave: '35503082256210013000140000000000001261100000000010', nNFSe: 12 })
  }

  it('lê xInfComp de serv/infoCompl e mostra no bloco "Informações complementares"', async () => {
    const xml = nfse(BANCO)
    expect(parseNfseXml(xml).dps.xInfComp).toBe(BANCO)
    const texts = pdfTexts(await renderDanfse(xml))
    expect(texts.join('\n')).toContain('Dados bancários: Caixa Economica Federal - Agencia: 0001 - Conta Corrente: 00012345-6')
    expect(texts.join('\n')).toContain('Totais aproximados dos tributos')
  })

  it('sem o campo, só os totais', async () => {
    expect(parseNfseXml(nfse(null)).dps.xInfComp).toBeNull()
  })

  it('2.000 caracteres de informação e de descrição cabem numa página, até o fim do texto', async () => {
    const info = `${'Banco 001 agência 0001 conta 12345-6 favorecido Contabilidade Modelo. '.repeat(40)}`.slice(0, 1995) + ' FIM.'
    const pdf = await renderDanfse(nfse(info, `${'Honorários contábeis do mês. '.repeat(80)}`.slice(0, 2000)))
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1)
    expect(pdfTexts(pdf).join(' ')).toContain('FIM.')
  })
})
