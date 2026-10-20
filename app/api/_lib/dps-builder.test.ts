// C6 (critério 4): a DPS leva CPF e nome do tomador, código de serviço nacional, descrição e
// valor; sem endereço do tomador e sem o grupo IBSCBS. Leiaute 1.01 (referência §1 e §2).
import { DOMParser } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import { buildDps, buildIdDps, DpsInvalidError } from './dps-builder.js'
import type { SefinTenant } from './sefin.js'

const NS = 'http://www.sped.fazenda.gov.br/nfse'

const tenant = (overrides: Partial<SefinTenant> = {}): SefinTenant => ({
  id: 't-1',
  cnpj: '56210013000140',
  razao_social: 'PRIMECARE SERVICOS MEDICOS LTDA',
  inscricao_municipal: null,
  codigo_municipio_ibge: '3550308',
  regime: 'simples',
  ambiente: 'producao_restrita',
  p_tot_trib_sn: '6.00',
  ...overrides,
})

const payload = {
  tomador: { cpf: '12345678909', nome: 'Maria da Silva' },
  servico: { codigo_servico_nacional: '040101', descricao: 'Consulta médica por telemedicina & retorno' },
  valor: '42.90',
}

const now = new Date('2026-11-03T13:00:00Z')

function parse(xml: string) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  const all = (name: string) => Array.from(doc.getElementsByTagNameNS(NS, name))
  const text = (name: string) => {
    const nodes = all(name)
    expect(nodes, `um único <${name}>`).toHaveLength(1)
    return nodes[0].textContent
  }
  return { doc, all, text }
}

describe('dps-builder (C6)', () => {
  it('monta tomador e serviço', () => {
    const { id, xml } = buildDps({ tenant: tenant(), serie: '1', numero: 731, payload, now })
    const { doc, all, text } = parse(xml)

    const root = doc.documentElement
    expect(root.localName).toBe('DPS')
    expect(root.namespaceURI).toBe(NS)
    expect(root.getAttribute('versao')).toBe('1.01')

    // Tomador: só CPF e nome (critério 4), sem endereço, telefone ou e-mail.
    const toma = all('toma')[0]
    expect(Array.from(toma.childNodes).map((n) => (n as Element).localName)).toEqual(['CPF', 'xNome'])
    expect(text('CPF')).toBe('12345678909')
    expect(text('xNome')).toBe('Maria da Silva')
    expect(all('end')).toHaveLength(0)

    // Serviço: código nacional e descrição do SKU; valor = amount_cents / 100 (já em reais no payload).
    expect(text('cTribNac')).toBe('040101')
    expect(text('xDescServ')).toBe('Consulta médica por telemedicina & retorno')
    expect(text('vServ')).toBe('42.90')

    // Sem o grupo IBSCBS (critério 4, corrigido em 20/10/2026) e sem cTribMun.
    expect(all('IBSCBS')).toHaveLength(0)
    expect(xml).not.toMatch(/IBSCBS|cTribMun|cNBS/)

    // Prestador do Simples emitindo a própria nota (referência §1).
    expect(text('tpEmit')).toBe('1')
    expect(text('opSimpNac')).toBe('3')
    expect(text('regApTribSN')).toBe('1')
    expect(text('regEspTrib')).toBe('0')
    expect(text('tribISSQN')).toBe('1')
    expect(text('tpRetISSQN')).toBe('1')
    expect(text('pTotTribSN')).toBe('6.00')
    expect(all('pAliq')).toHaveLength(0)
    expect(all('xNome').map((n) => (n.parentNode as Element).localName)).toEqual(['toma'])

    // Id e numeração (referência §2).
    // "DPS" + IBGE (7) + tipo de inscrição 2 = CNPJ (1) + CNPJ (14) + série (5) + número (15) = 45.
    expect(id).toBe(['DPS', '3550308', '2', '56210013000140', '00001', '000000000000731'].join(''))
    expect(id).toMatch(/^DPS[0-9]{42}$/)
    expect(all('infDPS')[0].getAttribute('Id')).toBe(id)
    expect(text('serie')).toBe('1')
    expect(text('nDPS')).toBe('731')
    expect(text('cLocEmi')).toBe('3550308')
    expect(text('cLocPrestacao')).toBe('3550308')

    // dhEmi 60 s antes do relógio, em -03:00; competência = data em São Paulo.
    expect(text('dhEmi')).toBe('2026-11-03T09:59:00-03:00')
    expect(text('dCompet')).toBe('2026-11-03')
    expect(text('tpAmb')).toBe('2')
  })

  it('sai sem indentação e sem espaço entre tags', () => {
    const { xml } = buildDps({ tenant: tenant(), serie: '1', numero: 1, payload, now })
    expect(xml.startsWith('<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infDPS Id="DPS')).toBe(true)
    expect(xml).not.toMatch(/>\s+</)
    expect(xml).not.toMatch(/^<\?xml/)
  })

  it('CR da descrição vira LF', () => {
    const { xml } = buildDps({
      tenant: tenant(),
      serie: '1',
      numero: 1,
      payload: { ...payload, servico: { ...payload.servico, descricao: 'linha 1\r\nlinha 2\rlinha 3' } },
      now,
    })
    expect(xml).not.toMatch(/\r|&#13;/)
    expect(parse(xml).text('xDescServ')).toBe('linha 1\nlinha 2\nlinha 3')
  })

  it('IM só quando o tenant tem; tpAmb 1 em produção', () => {
    const withIm = buildDps({ tenant: tenant({ inscricao_municipal: '12345678', ambiente: 'producao' }), serie: '1', numero: 1, payload, now })
    expect(parse(withIm.xml).text('IM')).toBe('12345678')
    expect(parse(withIm.xml).text('tpAmb')).toBe('1')
    const without = buildDps({ tenant: tenant(), serie: '1', numero: 1, payload, now })
    expect(parse(without.xml).all('IM')).toHaveLength(0)
  })

  // C40 de .checks/agente-fiscal-whatsapp.md (lote B2): tomador com CNPJ, XSD 1.01 `TCInfoPessoa`.
  it('tomador pessoa jurídica', () => {
    const pj = { ...payload, tomador: { cnpj: '11444777000161', nome: 'Hospital Alfa Ltda' } }
    const { xml } = buildDps({ tenant: tenant(), serie: '1', numero: 5, payload: pj, now })
    expect(xml).toContain('<toma><CNPJ>11444777000161</CNPJ><xNome>Hospital Alfa Ltda</xNome></toma>')
    const { all, text } = parse(xml)
    const toma = all('toma')[0]
    expect(Array.from(toma.childNodes).map((n) => (n as Element).localName)).toEqual(['CNPJ', 'xNome'])
    expect(all('CPF')).toHaveLength(0)
    expect(all('end')).toHaveLength(0)
    // O prestador continua identificado pelo CNPJ dele, antes do tomador.
    expect(all('CNPJ').map((n) => n.textContent)).toEqual(['56210013000140', '11444777000161'])
    expect(text('xNome')).toBe('Hospital Alfa Ltda')

    // O tomador com CPF continua como antes.
    const pf = buildDps({ tenant: tenant(), serie: '1', numero: 6, payload, now })
    expect(pf.xml).toContain('<toma><CPF>12345678909</CPF><xNome>Maria da Silva</xNome></toma>')

    // Exatamente um dos dois, no formato do leiaute; tomador igual ao prestador é recusado (E0202).
    const bad = (tomador: Record<string, unknown>) => () =>
      buildDps({ tenant: tenant(), serie: '1', numero: 7, payload: { ...payload, tomador }, now })
    expect(bad({ cpf: '12345678909', cnpj: '11444777000161', nome: 'X' })).toThrow(DpsInvalidError)
    expect(bad({ nome: 'Sem documento' })).toThrow(DpsInvalidError)
    expect(bad({ cnpj: '1144477700016', nome: 'X' })).toThrow(DpsInvalidError)
    expect(bad({ cnpj: '11.444.777/0001-61', nome: 'X' })).toThrow(DpsInvalidError)
    expect(bad({ cnpj: '56210013000140', nome: 'A própria empresa' })).toThrow(DpsInvalidError)
  })

  it('recusa dado fora do leiaute com DPS_INVALID', () => {
    const bad = (overrides: Record<string, unknown>, t = tenant(), serie = '1') => () =>
      buildDps({ tenant: t, serie, numero: 1, payload: { ...payload, ...overrides }, now })
    expect(bad({ servico: { ...payload.servico, codigo_servico_nacional: '0401' } })).toThrow(DpsInvalidError)
    expect(bad({ tomador: { ...payload.tomador, nome: 'x'.repeat(151) } })).toThrow(DpsInvalidError)
    expect(bad({ servico: { ...payload.servico, descricao: 'x'.repeat(2001) } })).toThrow(DpsInvalidError)
    expect(bad({}, tenant(), '50000')).toThrow(DpsInvalidError)
    expect(bad({}, tenant({ p_tot_trib_sn: null }))).toThrow(DpsInvalidError)
    expect(() => buildIdDps(tenant(), '0', 1)).toThrow(DpsInvalidError)
    let caught: unknown = null
    try {
      bad({ valor: '0.00' })()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DpsInvalidError)
    expect((caught as DpsInvalidError).code).toBe('DPS_INVALID')
  })
})
