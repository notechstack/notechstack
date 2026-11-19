// Retenção na DPS (Lucca, 16/11/2026; .design/agente-fiscal-retencoes.md): ISS retido pelo tomador (tpRetISSQN 2 +
// pAliq + endereço do tomador, E0621/E0237) e INSS retido (tribFed/vRetCP, E0699), na ordem do XSD 1.01.
import { DOMParser } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import { buildDps, DpsInvalidError } from './dps-builder.js'
import type { SefinTenant } from './sefin.js'

const NS = 'http://www.sped.fazenda.gov.br/nfse'

const tenant = (overrides: Partial<SefinTenant> = {}): SefinTenant => ({
  id: 't-1',
  cnpj: '56210013000140',
  razao_social: 'OFICINA TRILHO LTDA',
  inscricao_municipal: null,
  codigo_municipio_ibge: '3507605',
  regime: 'simples',
  ambiente: 'producao_restrita',
  p_tot_trib_sn: '6.00',
  ...overrides,
})

const ENDERECO = { cMun: '3550308', cep: '01310100', logradouro: 'AVENIDA PAULISTA', numero: '1000', complemento: 'CONJ 12', bairro: 'BELA VISTA' }

const base = {
  tomador: { cnpj: '11222333000181', nome: 'Clínica Saúde Ltda' },
  // 07.02.01 é de construção civil: a obra é obrigatória (E0370, obra.ts).
  servico: {
    codigo_servico_nacional: '070201',
    descricao: 'Manutenção predial - novembro/2026',
    obra: { cep: '01310100', logradouro: 'Avenida Paulista', numero: '1000', bairro: 'Bela Vista' },
  },
  valor: '1500.00',
}
const now = new Date('2026-11-16T13:00:00Z')

function parse(xml: string) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  const all = (name: string) => Array.from(doc.getElementsByTagNameNS(NS, name))
  const filhos = (name: string) => Array.from(all(name)[0].childNodes).map((n) => (n as Element).localName)
  const text = (name: string) => all(name)[0]?.textContent ?? null
  return { all, filhos, text }
}

const montar = (payload: unknown, t: Partial<SefinTenant> = {}) => buildDps({ tenant: tenant(t), serie: '1', numero: 7, payload, now }).xml

function recusa(payload: unknown, t: Partial<SefinTenant> = {}): string {
  try {
    montar(payload, t)
  } catch (error) {
    expect(error).toBeInstanceOf(DpsInvalidError)
    return (error as Error).message
  }
  throw new Error('a DPS deveria ser recusada')
}

describe('dps-builder: retenção', () => {
  it('sem retenção: o XML de sempre (tpRetISSQN 1, sem pAliq, sem tribFed, sem endereço)', () => {
    const { filhos, all, text } = parse(montar(base))
    expect(filhos('tribMun')).toEqual(['tribISSQN', 'tpRetISSQN'])
    expect(text('tpRetISSQN')).toBe('1')
    expect(filhos('trib')).toEqual(['tribMun', 'totTrib'])
    expect(all('tribFed')).toHaveLength(0)
    expect(filhos('toma')).toEqual(['CNPJ', 'xNome'])
  })

  it('ISS retido: tpRetISSQN 2, pAliq depois dele e o endereço nacional do tomador', () => {
    const { filhos, text } = parse(montar({ ...base, tomador: { ...base.tomador, endereco: ENDERECO }, retencao: { iss: { aliquota: '2.50' } } }))
    expect(filhos('tribMun')).toEqual(['tribISSQN', 'tpRetISSQN', 'pAliq'])
    expect(text('tribISSQN')).toBe('1')
    expect(text('tpRetISSQN')).toBe('2')
    expect(text('pAliq')).toBe('2.50')
    expect(filhos('toma')).toEqual(['CNPJ', 'xNome', 'end'])
    expect(filhos('end')).toEqual(['endNac', 'xLgr', 'nro', 'xCpl', 'xBairro'])
    expect(filhos('endNac')).toEqual(['cMun', 'CEP'])
    expect([text('cMun'), text('CEP'), text('xLgr'), text('nro'), text('xCpl'), text('xBairro')]).toEqual([
      '3550308',
      '01310100',
      'AVENIDA PAULISTA',
      '1000',
      'CONJ 12',
      'BELA VISTA',
    ])
    expect(filhos('trib')).toEqual(['tribMun', 'totTrib'])
  })

  it('endereço sem complemento: sem xCpl', () => {
    const { filhos } = parse(montar({ ...base, tomador: { ...base.tomador, endereco: { ...ENDERECO, complemento: null } }, retencao: { iss: { aliquota: '2.00' } } }))
    expect(filhos('end')).toEqual(['endNac', 'xLgr', 'nro', 'xBairro'])
  })

  it('INSS retido: tribFed com vRetCP entre tribMun e totTrib; ISS segue não retido', () => {
    const { filhos, text } = parse(montar({ ...base, retencao: { inss: { valor: '165.00' } } }))
    expect(filhos('trib')).toEqual(['tribMun', 'tribFed', 'totTrib'])
    expect(filhos('tribFed')).toEqual(['vRetCP'])
    expect(text('vRetCP')).toBe('165.00')
    expect(text('tpRetISSQN')).toBe('1')
    expect(filhos('toma')).toEqual(['CNPJ', 'xNome'])
  })

  it('ISS e INSS retidos juntos', () => {
    const { filhos, text } = parse(
      montar({ ...base, tomador: { ...base.tomador, endereco: ENDERECO }, retencao: { iss: { aliquota: '5.00' }, inss: { valor: '165.00' } } }),
    )
    expect(filhos('trib')).toEqual(['tribMun', 'tribFed', 'totTrib'])
    expect(text('pAliq')).toBe('5.00')
    expect(text('vRetCP')).toBe('165.00')
    expect(text('pTotTribSN')).toBe('6.00')
  })

  it('MEI não tem retenção (E0583, E0676)', () => {
    const mei = { regime: 'mei' as const, p_tot_trib_sn: null }
    expect(recusa({ ...base, tomador: { ...base.tomador, endereco: ENDERECO }, retencao: { iss: { aliquota: '2.00' } } }, mei)).toMatch(/MEI/)
    expect(recusa({ ...base, retencao: { inss: { valor: '10.00' } } }, mei)).toMatch(/MEI/)
  })

  it('ISS retido sem endereço (E0237) ou de tomador CPF é recusado antes da Sefin', () => {
    expect(recusa({ ...base, retencao: { iss: { aliquota: '2.00' } } })).toMatch(/endereço/)
    expect(recusa({ ...base, tomador: { cpf: '52998224725', nome: 'Maria', endereco: ENDERECO }, retencao: { iss: { aliquota: '2.00' } } })).toMatch(/CNPJ/)
  })

  it('formato e faixa: pAliq 0.00 de 2% a 5% (E0595), vRetCP menor que o serviço (E0699), retenções dentro do valor (E0428)', () => {
    const comEnd = { ...base, tomador: { ...base.tomador, endereco: ENDERECO } }
    expect(recusa({ ...comEnd, retencao: { iss: { aliquota: '2.5' } } })).toMatch(/formato/)
    expect(recusa({ ...comEnd, retencao: { iss: { aliquota: '5.01' } } })).toMatch(/2%–5%/)
    expect(recusa({ ...comEnd, retencao: { iss: { aliquota: '1.80' } } })).toMatch(/2%–5%/)
    expect(recusa({ ...base, retencao: { inss: { valor: '1500.00' } } })).toMatch(/menor que o valor/)
    expect(recusa({ ...base, retencao: { inss: { valor: '0.00' } } })).toMatch(/positivo/)
    expect(recusa({ ...comEnd, retencao: { iss: { aliquota: '5.00' }, inss: { valor: '1450.00' } } })).toMatch(/passam do valor/)
    expect(recusa({ ...base, retencao: 'sim' })).toMatch(/objeto/)
    expect(recusa({ ...base, tomador: { ...base.tomador, endereco: { ...ENDERECO, cep: '123' } } })).toMatch(/endereço/)
  })
})
