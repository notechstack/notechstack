// NFS-e com "Tomador/Adquirente não informado" (Bragantina, 27/11/2026): a DPS sai sem `toma` nos três leiautes
// (produção 1.01, NT 009 release 1 e release 2), validada contra os XSD oficiais; retenção, 17.05.01 e locação recusam;
// a API, o payload do agente e o DANFSe tratam a marca explícita `tomador_nao_informado`.
import { DOMParser } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import { pdfTexts } from '../_tests/pdf-text.js'
import { testNfseXml } from '../_tests/sefin-fake.js'
import { errosXsd, pacoteDaDps, type PacoteXsd } from '../_tests/xsd.js'
import { lerPayload, payloadDaNota } from './agente/notas.js'
import { renderDanfse } from './danfse-renderer.js'
import { buildDps, DpsInvalidError, parseDpsPayload, type LeiauteDps, type OpcoesDps } from './dps-builder.js'
import { parseNfseXml } from './nfse-xml.js'
import { resolverRetencao, SEM_RETENCAO_PADRAO } from './retencao.js'
import type { SefinTenant } from './sefin.js'
import { marcaSemTomador, problemaDoCodigoSemTomador } from './tomador-nao-informado.js'
import { parseNewInvoice } from './validation.js'

const NS = 'http://www.sped.fazenda.gov.br/nfse'

const tenant = (overrides: Partial<SefinTenant> = {}): SefinTenant => ({
  id: 't-1',
  cnpj: '56210013000140',
  razao_social: 'CLINICA EXEMPLO LTDA',
  inscricao_municipal: null,
  codigo_municipio_ibge: '3507605',
  regime: 'simples',
  ambiente: 'producao',
  p_tot_trib_sn: '6.00',
  ...overrides,
})

const semTomador = (extra: Record<string, unknown> = {}) => ({
  tomador_nao_informado: true,
  // 04.01.01 (medicina): incidência no estabelecimento do prestador.
  servico: { codigo_servico_nacional: '040101', descricao: 'Consulta avulsa' },
  valor: '150.00',
  ...extra,
})

const now = new Date('2026-11-27T13:00:00Z')
const PACOTE: Record<LeiauteDps, PacoteXsd> = {
  'v1.01': 'producao-v1.01-20260209',
  nt009: 'producao-restrita-20261020',
  nt009r2: 'producao-restrita-20261124',
}

const gerar = (payload: unknown, opcoes: OpcoesDps, t: Partial<SefinTenant> = {}) =>
  buildDps({ tenant: tenant(t), serie: '1', numero: 9, payload, now, opcoes })

function filhos(xml: string, nome: string): string[] {
  const no = new DOMParser().parseFromString(xml, 'text/xml').getElementsByTagNameNS(NS, nome)[0]
  return no ? Array.from(no.childNodes).map((n) => (n as Element).localName) : []
}

function recusa(payload: unknown, opcoes: OpcoesDps = { leiaute: 'v1.01', ibscbs: false }, t: Partial<SefinTenant> = {}): string {
  try {
    gerar(payload, opcoes, t)
  } catch (error) {
    expect(error).toBeInstanceOf(DpsInvalidError)
    return (error as Error).message
  }
  throw new Error('a DPS deveria ser recusada')
}

describe('marca "sem tomador" no texto', () => {
  it.each([
    'nota de 150 pra consumidor não identificado',
    'emite 150 sem tomador',
    'nota de 80 consumidor final',
    'cliente não informado, 200 reais',
    'Tomador não informado',
    'NAO INFORMADO',
    'consumidores diversos',
    'nota sem CPF do cliente de 90',
    'consumidor',
  ])('"%s" é sem tomador', (texto) => {
    expect(marcaSemTomador(texto)).toBe(true)
  })

  it.each(['nota de 150 pra Maria Silva', 'Padaria Exemplo Ltda', 'Informática Não Para Ltda', '', null, 'consumo de energia'])(
    '"%s" não é',
    (texto) => {
      expect(marcaSemTomador(texto)).toBe(false)
    },
  )

  it('17.05.01 exige o tomador (E0234); os demais, não', () => {
    expect(problemaDoCodigoSemTomador('170501')).toMatch(/17\.05\.01/)
    expect(problemaDoCodigoSemTomador('040101')).toBeNull()
  })
})

describe('DPS sem toma: os três leiautes, contra os XSD oficiais', () => {
  for (const leiaute of ['v1.01', 'nt009', 'nt009r2'] as const) {
    it(`${leiaute}: sem o grupo toma, válida no XSD ${PACOTE[leiaute]}`, async () => {
      const { xml } = gerar(semTomador(), { leiaute, ibscbs: false })
      expect(xml).not.toContain('<toma>')
      expect(xml).not.toContain('<CPF>')
      expect(filhos(xml, 'infDPS')).not.toContain('toma')
      expect(pacoteDaDps(xml)).toBe(PACOTE[leiaute])
      expect(await errosXsd(xml, PACOTE[leiaute])).toEqual([])
    })
  }

  it('release 2: indDest 0 logo depois de prest, sem o grupo dest (E0908/E0910)', async () => {
    const { xml } = gerar(semTomador(), { leiaute: 'nt009r2', ibscbs: false })
    const ordem = filhos(xml, 'infDPS')
    expect(ordem.slice(ordem.indexOf('prest'), ordem.indexOf('prest') + 3)).toEqual(['prest', 'indDest', 'serv'])
    expect(xml).toContain('</prest><indDest>0</indDest><serv>')
    expect(xml).not.toContain('<dest>')
  })

  it('com o IBSCBS ligado: sem tomador, o grupo não vai (E0187/E0243), e a DPS segue válida', async () => {
    // 10.04.01: NBS, cIndOp e cClassTrib resolvidos pela tabela (com tomador, o grupo sai).
    const servico = { codigo_servico_nacional: '100401', descricao: 'Agenciamento de contratos' }
    for (const leiaute of ['v1.01', 'nt009', 'nt009r2'] as const) {
      const comTomador = gerar({ servico, valor: '150.00', tomador: { cpf: '52998224725', nome: 'Maria' } }, { leiaute, ibscbs: true })
      expect(comTomador.xml).toContain('<IBSCBS>')
      const { xml } = gerar(semTomador({ servico }), { leiaute, ibscbs: true })
      expect(xml).not.toContain('<IBSCBS>')
      expect(await errosXsd(xml, PACOTE[leiaute])).toEqual([])
    }
  })

  it('Presumido (opSimpNac 1) e MEI também saem sem toma', async () => {
    const presumido = gerar(semTomador(), { leiaute: 'nt009r2', ibscbs: false }, { regime: 'presumido', p_tot_trib: { fed: '13.45', est: null, mun: '2.00' } })
    expect(await errosXsd(presumido.xml, 'producao-restrita-20261124')).toEqual([])
    const mei = gerar(semTomador(), { leiaute: 'v1.01', ibscbs: false }, { regime: 'mei' })
    expect(mei.xml).not.toContain('<toma>')
    expect(await errosXsd(mei.xml, 'producao-v1.01-20260209')).toEqual([])
  })
})

describe('DPS sem tomador: o que a Sefin recusaria não sai', () => {
  it('ISS retido (E0204)', () => {
    expect(recusa(semTomador({ retencao: { iss: { aliquota: '2.00' } } }))).toMatch(/não tem retenção.*E0204/)
  })

  it('INSS retido e, no Presumido, IRRF e PIS/COFINS/CSLL', () => {
    expect(recusa(semTomador({ retencao: { inss: { valor: '16.50' } } }))).toMatch(/não tem retenção/)
    const presumido = { regime: 'presumido' as const, p_tot_trib: { fed: '13.45', est: null, mun: '2.00' } }
    expect(recusa(semTomador({ retencao: { irrf: { valor: '2.25' } } }), undefined, presumido)).toMatch(/não tem retenção/)
    expect(recusa(semTomador({ retencao: { csrf: { valor: '6.98' } } }), undefined, presumido)).toMatch(/não tem retenção/)
  })

  it('17.05.01 (fornecimento de mão de obra, incidência no tomador)', () => {
    expect(recusa(semTomador({ servico: { codigo_servico_nacional: '170501', descricao: 'Mão de obra temporária' } }))).toMatch(/17\.05\.01/)
  })

  it('locação (o IBSCBS vai sempre, e o local depende do adquirente)', () => {
    const locacao = semTomador({
      servico: {
        codigo_servico_nacional: '990401',
        descricao: 'Locação de betoneira',
        locacao: { bens: [{ ncm: '84743100', descricao: 'Betoneira 400 litros', quantidade: 1 }] },
      },
    })
    expect(recusa(locacao, { leiaute: 'nt009r2', ibscbs: false, locacao: true })).toMatch(/inquilino/)
  })
})

describe('payload do motor: a marca é explícita', () => {
  it('sem tomador e sem a marca: recusa (ninguém emite sem tomador por esquecimento)', () => {
    expect(() => parseDpsPayload({ servico: { codigo_servico_nacional: '040101', descricao: 'x' }, valor: '1.00' })).toThrow(/tomador_nao_informado/)
    expect(() => parseDpsPayload({ tomador: null, servico: { codigo_servico_nacional: '040101', descricao: 'x' }, valor: '1.00' })).toThrow(/tomador_nao_informado/)
  })

  it('a marca com tomador junto é contradição', () => {
    expect(() => parseDpsPayload({ ...semTomador(), tomador: { cpf: '52998224725', nome: 'Maria' } })).toThrow(/não pode vir com tomador/)
    expect(() => parseDpsPayload({ ...semTomador(), tomador_nao_informado: 'sim' })).toThrow(/true ou false/)
  })

  it('a marca sozinha: tomador null', () => {
    expect(parseDpsPayload(semTomador()).tomador).toBeNull()
  })

  it('payloadDaNota(null) grava a marca e nada do tomador; lerPayload devolve "consumidor não identificado"', () => {
    const payload = payloadDaNota(null, { codigo: '040101', descricao: 'Consulta avulsa' }, '150.00', {
      endereco: { cMun: '3507605', cep: '12900000', logradouro: 'RUA X', numero: '1', complemento: null, bairro: 'CENTRO' },
    })
    expect(payload).toEqual({ tomador_nao_informado: true, servico: { codigo_servico_nacional: '040101', descricao: 'Consulta avulsa' }, valor: '150.00' })
    expect(lerPayload(payload)).toEqual({ semTomador: true, documento: null, nome: 'consumidor não identificado', email: null, valor: '150.00' })
    // O payload do agente monta a DPS.
    expect(gerar(payload, { leiaute: 'nt009r2', ibscbs: false }).xml).not.toContain('<toma>')
  })
})

describe('API: POST /v1/nfse com tomador_nao_informado', () => {
  const corpo = (extra: Record<string, unknown> = {}) => ({ external_id: 'pdv-1', valor: '150.00', ...extra })

  it('"tomador_nao_informado": true, sem tomador: aceito, tomador null', () => {
    const r = parseNewInvoice(corpo({ tomador_nao_informado: true }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.tomador).toBeNull()
  })

  it('sem tomador e sem a marca: a mensagem diz como pedir a nota sem tomador', () => {
    const r = parseNewInvoice(corpo())
    expect(r).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    if (!r.ok) expect(r.message).toMatch(/tomador_nao_informado/)
    expect(parseNewInvoice(corpo({ tomador_nao_informado: false })).ok).toBe(false)
  })

  it('a marca com tomador, ou com tipo errado: recusa', () => {
    expect(parseNewInvoice(corpo({ tomador_nao_informado: true, tomador: { cpf: '52998224725', nome: 'Maria' } })).ok).toBe(false)
    expect(parseNewInvoice(corpo({ tomador_nao_informado: 'sim' })).ok).toBe(false)
  })

  it('com tomador, igual a antes', () => {
    const r = parseNewInvoice(corpo({ tomador: { cpf: '52998224725', nome: 'Maria' } }))
    expect(r.ok && r.value.tomador).toEqual({ documento: '52998224725', nome: 'Maria', email: null })
  })
})

describe('retenção sem tomador', () => {
  const padraoComIss = { retem_iss: true, aliquota_iss: '2.00', retem_inss: true, inss_percentual: '11.00' }

  it('o padrão da empresa (ISS e INSS) não vale: a nota sai sem retenção', () => {
    expect(resolverRetencao({ padrao: padraoComIss, valor: '150.00', regime: 'simples', tomadorTipo: null })).toEqual({ ok: true, retencao: null })
  })

  it('o pedido com retenção é recusado (E0204)', () => {
    for (const pedido of [{ iss: true, aliquotaIss: '2' }, { inss: true, inssTexto: '11%' }]) {
      expect(resolverRetencao({ padrao: SEM_RETENCAO_PADRAO, pedido, valor: '150.00', regime: 'simples', tomadorTipo: null })).toEqual({
        ok: false,
        problema: 'RETENCAO_SEM_TOMADOR',
      })
    }
  })
})

describe('DANFSe da nota sem tomador', () => {
  it('o quadro do tomador diz "não identificado" (NT 008), e o leitor da NFS-e devolve tomador null', async () => {
    const { xml } = gerar(semTomador(), { leiaute: 'v1.01', ibscbs: false }, { ambiente: 'producao_restrita' })
    const nfse = testNfseXml({ dpsXml: xml, chave: '35076052256210013000140000000000009261100000000010', nNFSe: 9 })
    expect(parseNfseXml(nfse).dps.tomador).toBeNull()
    const textos = pdfTexts(await renderDanfse(nfse))
    expect(textos).toContain('TOMADOR/ADQUIRENTE DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e')
    expect(textos).toContain('Consulta avulsa')
  })
})
