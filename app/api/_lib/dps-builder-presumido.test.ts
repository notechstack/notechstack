// Lucro Presumido e Real na DPS (Lucca, 19/11/2026) e a virada da NT 009 (01/12/2026). Fontes oficiais em
// side-session-notes/…/presumido-nt009-fontes.md (Anexo I prodrest 20261020 e Anexo VI-NT009 v1.04.01). Todo XML é
// validado contra os dois XSD oficiais; MEI, Simples e Presumido saem válidos no leiaute da NT 009.
import { DOMParser } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import { sharedTestCertificate } from '../_tests/certs.js'
import { errosXsd, type PacoteXsd } from '../_tests/xsd.js'
import { parseNfseXml } from './nfse-xml.js'
import { buildDps, DpsInvalidError, opcoesDpsDoAmbiente, regimeNaoOptante, VIRADA_NT009, type OpcoesDps } from './dps-builder.js'
import { pfxToPem } from './pfx.js'
import type { SefinTenant } from './sefin.js'
import { signXml } from './xml-signer.js'

const NS = 'http://www.sped.fazenda.gov.br/nfse'
const PROD: PacoteXsd = 'producao-v1.01-20260209'
const PR: PacoteXsd = 'producao-restrita-20261020'
const V101: OpcoesDps = { leiaute: 'v1.01', ibscbs: false }
const NT009: OpcoesDps = { leiaute: 'nt009', ibscbs: false }
const NT009_IBSCBS: OpcoesDps = { leiaute: 'nt009', ibscbs: true }

const PRESUMIDO: Partial<SefinTenant> = {
  regime: 'presumido',
  p_tot_trib_sn: null,
  p_tot_trib: { fed: '13.45', est: '0', mun: '5.00' },
  codigo_municipio_ibge: '3304557',
}

const tenant = (o: Partial<SefinTenant> = {}): SefinTenant => ({
  id: 't-1',
  cnpj: '56210013000140',
  razao_social: 'CONSULTORIA MODELO LTDA',
  inscricao_municipal: null,
  codigo_municipio_ibge: '3550308',
  regime: 'simples',
  ambiente: 'producao',
  p_tot_trib_sn: '6.00',
  ...o,
})

const ENDERECO = { cMun: '3304557', cep: '20040002', logradouro: 'AVENIDA RIO BRANCO', numero: '1', bairro: 'CENTRO' }
const payload = (extra: Record<string, unknown> = {}) => ({
  tomador: { cnpj: '11222333000181', nome: 'Cliente Tomador SA', endereco: ENDERECO },
  // 100401: resolve NBS, cIndOp e cClassTrib pelo Anexo VIII (o grupo IBSCBS sai).
  servico: { codigo_servico_nacional: '100401', descricao: 'Agenciamento de contratos' },
  valor: '10000.00',
  ...extra,
})
const now = new Date('2026-12-01T13:00:00Z')

const gerar = (t: Partial<SefinTenant>, opcoes: OpcoesDps, p: unknown = payload()) =>
  buildDps({ tenant: tenant(t), serie: '1', numero: 9, payload: p, now, opcoes }).xml

function doc(xml: string) {
  const d = new DOMParser().parseFromString(xml, 'text/xml')
  const all = (n: string) => Array.from(d.getElementsByTagNameNS(NS, n))
  return {
    all,
    texto: (n: string) => all(n)[0]?.textContent ?? null,
    filhos: (n: string) => (all(n)[0] ? Array.from(all(n)[0].childNodes).map((c) => (c as Element).localName) : []),
  }
}

function recusa(t: Partial<SefinTenant>, p: unknown): string {
  try {
    gerar(t, NT009, p)
  } catch (error) {
    expect(error).toBeInstanceOf(DpsInvalidError)
    return (error as Error).message
  }
  throw new Error('a DPS deveria ser recusada')
}

describe('Presumido e Real: prestador não optante (opSimpNac 1)', () => {
  it('regTrib sem regApTribSN (E0162), pTotTrib no lugar de pTotTribSN (E0713), sem pAliq; válida nos dois XSD', async () => {
    for (const [opcoes, pacote] of [[V101, PROD], [NT009, PR], [NT009_IBSCBS, PR]] as const) {
      const xml = gerar(PRESUMIDO, opcoes)
      const d = doc(xml)
      expect(d.filhos('regTrib')).toEqual(['opSimpNac', 'regEspTrib'])
      expect(d.texto('opSimpNac')).toBe('1')
      expect(d.filhos('totTrib')).toEqual(['pTotTrib'])
      expect(d.filhos('pTotTrib')).toEqual(['pTotTribFed', 'pTotTribEst', 'pTotTribMun'])
      expect([d.texto('pTotTribFed'), d.texto('pTotTribEst'), d.texto('pTotTribMun')]).toEqual(['13.45', '0.00', '5.00'])
      expect(d.all('pAliq')).toHaveLength(0)
      expect(d.all('indTotTrib')).toHaveLength(0)
      expect(await errosXsd(xml, pacote)).toEqual([])
    }
  })

  it('Lucro Real sai igual ao Presumido (a DPS não distingue os dois)', () => {
    expect(gerar({ ...PRESUMIDO, regime: 'real' }, NT009)).toBe(gerar(PRESUMIDO, NT009))
    expect(regimeNaoOptante('real')).toBe(true)
    expect(regimeNaoOptante('simples')).toBe(false)
  })

  it('com IBSCBS ligado, o grupo sai igual ao do Simples (a Sefin calcula), na NT 009', async () => {
    const xml = gerar(PRESUMIDO, NT009_IBSCBS)
    expect(doc(xml).all('IBSCBS')).toHaveLength(1)
    expect(doc(xml).texto('cClassTrib')).toBe('000001')
    expect(await errosXsd(xml, PR)).toEqual([])
  })

  it('sem percentual da Lei 12.741 configurado, a nota não sai', () => {
    expect(recusa({ ...PRESUMIDO, p_tot_trib: null }, payload())).toMatch(/federais/)
    expect(recusa({ ...PRESUMIDO, p_tot_trib: { fed: '13.45', est: null, mun: null } }, payload())).toMatch(/municipais/)
    expect(recusa({ ...PRESUMIDO, p_tot_trib: { fed: '130', est: '0', mun: '5' } }, payload())).toMatch(/0–100/)
  })

  it('ISS retido: tpRetISSQN 2 sem pAliq (E0617), endereço do tomador; válida nos dois XSD', async () => {
    const p = payload({ retencao: { iss: { aliquota: '5.00' } } })
    for (const [opcoes, pacote] of [[V101, PROD], [NT009, PR]] as const) {
      const xml = gerar(PRESUMIDO, opcoes, p)
      expect(doc(xml).filhos('tribMun')).toEqual(['tribISSQN', 'tpRetISSQN'])
      expect(doc(xml).texto('tpRetISSQN')).toBe('2')
      expect(doc(xml).all('endNac')).toHaveLength(1)
      expect(await errosXsd(xml, pacote)).toEqual([])
    }
  })

  it('IRRF, PIS/COFINS/CSLL e INSS retidos: tribFed na ordem do XSD, CST 01 e tpRetPisCofins 3 (E0724)', async () => {
    const p = payload({ retencao: { inss: { valor: '1100.00' }, irrf: { valor: '150.00' }, csrf: { valor: '465.00' } } })
    for (const [opcoes, pacote] of [[V101, PROD], [NT009, PR]] as const) {
      const xml = gerar(PRESUMIDO, opcoes, p)
      const d = doc(xml)
      expect(d.filhos('tribFed')).toEqual(['piscofins', 'vRetCP', 'vRetIRRF', 'vRetCSLL'])
      expect(d.filhos('piscofins')).toEqual(['CST', 'tpRetPisCofins'])
      expect([d.texto('CST'), d.texto('tpRetPisCofins'), d.texto('vRetIRRF'), d.texto('vRetCSLL')]).toEqual(['01', '3', '150.00', '465.00'])
      expect(await errosXsd(xml, pacote)).toEqual([])
    }
    // Só IRRF: sem piscofins, sem vRetCSLL (E0720 não se aplica).
    const soIrrf = doc(gerar(PRESUMIDO, NT009, payload({ retencao: { irrf: { valor: '150.00' } } })))
    expect(soIrrf.filhos('tribFed')).toEqual(['vRetIRRF'])
  })

  it('retenção federal: Simples e MEI recusam; valores fora do formato ou acima do serviço também', () => {
    const irrf = payload({ retencao: { irrf: { valor: '150.00' } } })
    expect(recusa({}, irrf)).toMatch(/Presumido ou Real/)
    expect(recusa({ regime: 'mei', p_tot_trib_sn: null }, irrf)).toMatch(/MEI/)
    expect(recusa(PRESUMIDO, payload({ retencao: { irrf: { valor: '150' } } }))).toMatch(/2 casas/)
    expect(recusa(PRESUMIDO, payload({ retencao: { csrf: { valor: '10000.00' } } }))).toMatch(/menor que o valor/)
    expect(recusa(PRESUMIDO, payload({ retencao: { inss: { valor: '6000.00' }, csrf: { valor: '5000.00' } } }))).toMatch(/passam do valor/)
  })

  it('regime desconhecido não vira DPS de Simples', () => {
    expect(recusa({ regime: 'arbitrado' }, payload())).toMatch(/não atendido/)
  })

  it('assinada, continua válida na NT 009', async () => {
    const pem = pfxToPem(sharedTestCertificate().certificado)
    const xml = signXml({ xml: gerar(PRESUMIDO, NT009_IBSCBS), signedElement: 'infDPS', keyPem: pem.keyPem, certPem: pem.certPem })
    expect(await errosXsd(xml, PR)).toEqual([])
  })
})

describe('virada da NT 009: MEI, Simples e Presumido no leiaute novo', () => {
  const casos: [string, Partial<SefinTenant>][] = [
    ['MEI', { regime: 'mei', p_tot_trib_sn: null }],
    ['Simples', {}],
    ['Presumido', PRESUMIDO],
  ]
  it.each(casos)('%s: válida no XSD da NT 009, com e sem IBSCBS, com finNFSe e cNBS antes de xDescServ', async (_n, t) => {
    for (const opcoes of [NT009, NT009_IBSCBS]) {
      const xml = gerar(t, opcoes, payload({ servico: { codigo_servico_nacional: '100401', descricao: 'Agenciamento', nbs: '1.1502.10.00' } }))
      expect(doc(xml).texto('finNFSe')).toBe('0')
      expect(doc(xml).filhos('cServ')).toEqual(['cTribNac', 'cNBS', 'xDescServ'])
      expect(await errosXsd(xml, PR)).toEqual([])
    }
  })

  it('produção vira sozinha em 01/12/2026 00:00 de Brasília; NOFISCAL_DPS_LEIAUTE manda nos dois sentidos', () => {
    const antes = new Date(VIRADA_NT009.getTime() - 1)
    const depois = VIRADA_NT009
    expect(opcoesDpsDoAmbiente({ ambiente: 'producao' }, {}, antes).leiaute).toBe('v1.01')
    expect(opcoesDpsDoAmbiente({ ambiente: 'producao' }, {}, depois).leiaute).toBe('nt009')
    expect(VIRADA_NT009.toISOString()).toBe('2026-12-01T03:00:00.000Z')
    // Rollback: a Sefin adiou ou recusa o leiaute novo.
    expect(opcoesDpsDoAmbiente({ ambiente: 'producao' }, { NOFISCAL_DPS_LEIAUTE: 'v1.01' }, depois).leiaute).toBe('v1.01')
    // Antecipar (teste).
    expect(opcoesDpsDoAmbiente({ ambiente: 'producao' }, { NOFISCAL_DPS_LEIAUTE: 'nt009' }, antes).leiaute).toBe('nt009')
    // Valor errado não muda nada; produção restrita é sempre nt009.
    expect(opcoesDpsDoAmbiente({ ambiente: 'producao' }, { NOFISCAL_DPS_LEIAUTE: 'NT009' }, antes).leiaute).toBe('v1.01')
    expect(opcoesDpsDoAmbiente({ ambiente: 'producao_restrita' }, { NOFISCAL_DPS_LEIAUTE: 'v1.01' }, antes).leiaute).toBe('nt009')
  })
})

describe('DANFSe lê o tribFed', () => {
  it('parseNfseXml devolve as retenções federais da DPS', () => {
    const dps = gerar(PRESUMIDO, NT009, payload({ retencao: { inss: { valor: '1100.00' }, irrf: { valor: '150.00' }, csrf: { valor: '465.00' } } }))
    const inner = dps.replace(/^<DPS[^>]*>/, '').replace(/<\/DPS>$/, '')
    const nfse =
      `<NFSe xmlns="${NS}" versao="1.01"><infNFSe Id="NFS${'1'.repeat(50)}"><DPS versao="1.01">${inner}</DPS></infNFSe></NFSe>`
    const fed = parseNfseXml(nfse).dps.tribFed
    expect(fed).toEqual({
      vRetCP: '1100.00',
      vRetIRRF: '150.00',
      vRetCSLL: '465.00',
      piscofins: { CST: '01', vBCPisCofins: null, pAliqPis: null, pAliqCofins: null, vPis: null, vCofins: null, tpRetPisCofins: '3' },
    })
  })
})
