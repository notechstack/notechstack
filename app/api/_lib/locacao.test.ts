// NFS-e de locação (99.03.01 e 99.04.01), pesquisa de 26/11/2026 (side-session-notes/…/locacao-99-03-99-04-fontes.md).
// Toda DPS de locação é validada nos XSD oficiais dos releases 1 (20261020) e 2 (20261124) da NT 009, para MEI,
// Simples e Presumido, e assinada; a flag desligada e o leiaute v1.01 não montam nada.
import { DOMParser } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import { sharedTestCertificate } from '../_tests/certs.js'
import { pdfTexts } from '../_tests/pdf-text.js'
import { testNfseXml } from '../_tests/sefin-fake.js'
import { errosXsd, type PacoteXsd } from '../_tests/xsd.js'
import { renderDanfse } from './danfse-renderer.js'
import { buildDps, DpsInvalidError, opcoesDpsDoAmbiente, type OpcoesDps } from './dps-builder.js'
import {
  avisosDaLocacao,
  lerLocacao,
  lerValor,
  linhasDaLocacao,
  LOCACAO_IMOVEL,
  LOCACAO_MOVEL,
  MENSAGEM_LOCACAO_DESLIGADA,
  nbsDoBemMovel,
  parteDoLocador,
  problemaDaLocacao,
} from './locacao.js'
import { parseNfseXml } from './nfse-xml.js'
import { pfxToPem } from './pfx.js'
import type { SefinTenant } from './sefin.js'
import { signXml } from './xml-signer.js'

const NS = 'http://www.sped.fazenda.gov.br/nfse'
const R1: PacoteXsd = 'producao-restrita-20261020'
const R2: PacoteXsd = 'producao-restrita-20261124'
const LOC_R1: OpcoesDps = { leiaute: 'nt009', ibscbs: false, locacao: true }
const LOC_R2: OpcoesDps = { leiaute: 'nt009r2', ibscbs: false, locacao: true }

const REGIMES: Record<string, Partial<SefinTenant>> = {
  mei: { regime: 'mei', p_tot_trib_sn: null },
  simples: { regime: 'simples', p_tot_trib_sn: '6.00' },
  presumido: { regime: 'presumido', p_tot_trib_sn: null, p_tot_trib: { fed: '13.45', est: '0', mun: '5.00' } },
}

const tenant = (o: Partial<SefinTenant> = {}): SefinTenant => ({
  id: 't-1',
  cnpj: '56210013000140',
  razao_social: 'IMOBILIARIA MODELO LTDA',
  inscricao_municipal: null,
  codigo_municipio_ibge: '3550308',
  regime: 'simples',
  ambiente: 'producao_restrita',
  p_tot_trib_sn: '6.00',
  ...o,
})

const IMOVEL = {
  municipio_ibge: '3509502',
  cep: '13015-100',
  logradouro: 'Rua das Flores',
  numero: '120',
  complemento: 'apto 32',
  bairro: 'Centro',
  inscricao_imobiliaria: '3423.12.345.0001',
  residencial: true,
  vencimento: '2026-12-10',
}
const BENS = [{ ncm: '8703.23.10', descricao: 'Automovel Onix 1.0', quantidade: 2 }]

const payloadImovel = (imovel: Record<string, unknown> = IMOVEL, extra: Record<string, unknown> = {}) => ({
  tomador: { cpf: '12345678909', nome: 'Fulano de Tal' },
  servico: { codigo_servico_nacional: LOCACAO_IMOVEL, descricao: 'Aluguel de dezembro/2026', locacao: { imovel } },
  valor: '2500.00',
  ...extra,
})
const payloadMovel = (bens: unknown = BENS, servico: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  tomador: { cnpj: '11222333000181', nome: 'Cliente Tomador SA' },
  servico: { codigo_servico_nacional: LOCACAO_MOVEL, descricao: 'Aluguel de 2 carros em dezembro', locacao: { bens }, ...servico },
  valor: '3000.00',
  ...extra,
})
const now = new Date('2026-12-08T13:00:00Z')

const gerar = (t: Partial<SefinTenant>, opcoes: OpcoesDps, p: unknown) =>
  buildDps({ tenant: tenant(t), serie: '1', numero: 9, payload: p, now, opcoes }).xml

function doc(xml: string) {
  const d = new DOMParser().parseFromString(xml, 'text/xml')
  const all = (n: string) => Array.from(d.getElementsByTagNameNS(NS, n))
  return {
    texto: (n: string) => all(n)[0]?.textContent ?? null,
    filhos: (n: string) => (all(n)[0] ? Array.from(all(n)[0].childNodes).map((c) => (c as Element).localName) : []),
    existe: (n: string) => all(n).length > 0,
  }
}

describe('DPS de locação nos três regimes, válida nos XSD dos releases 1 e 2 da NT 009', () => {
  for (const [nome, regime] of Object.entries(REGIMES)) {
    it(`${nome}: 99.03.01 (imóvel) sem ISS, com imovel/gLocacao/gUnidImob`, async () => {
      for (const [opcoes, pacote] of [[LOC_R1, R1], [LOC_R2, R2]] as const) {
        const xml = gerar(regime, opcoes, payloadImovel())
        expect(await errosXsd(xml, pacote)).toEqual([])
        const d = doc(xml)
        expect(d.texto('cTribNac')).toBe('990301')
        expect(d.texto('cNBS')).toBe('110021000')
        // E0532 e E0580: não incidência, sem retenção nem alíquota.
        expect(d.filhos('tribMun')).toEqual(['tribISSQN', 'tpRetISSQN'])
        expect(d.texto('tribISSQN')).toBe('4')
        expect(d.texto('tpRetISSQN')).toBe('1')
        expect(d.filhos('imovel')).toEqual(['cMun', 'gLocacao', 'gUnidImob'])
        expect(d.texto('cMun')).toBe('3509502')
        expect(d.filhos('gLocacao')).toEqual(['pCopropriedade', 'vTotOper', 'dVencOrig'])
        expect(d.texto('pCopropriedade')).toBe('100.00')
        expect(d.texto('vTotOper')).toBe('2500.00')
        expect(d.filhos('gUnidImob')).toEqual(['inscImobFisc', 'end'])
        expect(d.texto('CEP')).toBe('13015100')
        expect(d.texto('cIndOp')).toBe('020101')
        expect(d.texto('CST')).toBe('200')
        expect(d.texto('cClassTrib')).toBe('200027')
        // Release 1: indDest dentro do IBSCBS; release 2: em infDPS, depois de toma.
        if (opcoes.leiaute === 'nt009') expect(d.filhos('IBSCBS')).toEqual(['cIndOp', 'indDest', 'imovel', 'valores'])
        else {
          expect(d.filhos('IBSCBS')).toEqual(['cIndOp', 'imovel', 'valores'])
          const filhos = d.filhos('infDPS')
          expect(filhos[filhos.indexOf('toma') + 1]).toBe('indDest')
        }
      }
    })

    it(`${nome}: 99.04.01 (bem móvel) sem ISS, com bensMoveis`, async () => {
      for (const [opcoes, pacote] of [[LOC_R1, R1], [LOC_R2, R2]] as const) {
        const xml = gerar(regime, opcoes, payloadMovel())
        expect(await errosXsd(xml, pacote)).toEqual([])
        const d = doc(xml)
        expect(d.texto('cTribNac')).toBe('990401')
        expect(d.texto('tribISSQN')).toBe('4')
        expect(d.filhos('bensMoveis')).toEqual(['cNCMBemMovel', 'xNCMBemMovel', 'qtdNCMBemMovel'])
        expect(d.texto('cNCMBemMovel')).toBe('87032310')
        expect(d.texto('qtdNCMBemMovel')).toBe('2')
        expect(d.texto('cNBS')).toBe('111011100')
        expect(d.texto('cIndOp')).toBe('010101')
        expect(d.texto('cClassTrib')).toBe('000001')
        expect(d.existe('imovel')).toBe(false)
      }
    })
  }

  it('Presumido com retenção federal na locação: tribFed sai junto, válido no XSD', async () => {
    const p = payloadMovel(BENS, {}, { retencao: { irrf: { valor: '45.00' } } })
    const xml = gerar(REGIMES.presumido, LOC_R2, p)
    expect(await errosXsd(xml, R2)).toEqual([])
    expect(doc(xml).texto('vRetIRRF')).toBe('45.00')
  })

  it('a DPS assinada continua válida no XSD do release 2', async () => {
    const xml = gerar(REGIMES.simples, LOC_R2, payloadImovel())
    const pem = pfxToPem(sharedTestCertificate().certificado)
    const assinado = signXml({ xml, signedElement: 'infDPS', keyPem: pem.keyPem, certPem: pem.certPem })
    expect(await errosXsd(assinado, R2)).toEqual([])
  })

  it('CIB no lugar do endereço; copropriedade de 50% com o aluguel inteiro em vTotOper (E0433)', async () => {
    const imovel = { municipio_ibge: '3550308', cib: 'ABC1234-5', residencial: 'comercial', copropriedade: '50', valor_total: '5000,00' }
    const xml = gerar(REGIMES.presumido, LOC_R2, payloadImovel(imovel))
    expect(await errosXsd(xml, R2)).toEqual([])
    const d = doc(xml)
    expect(d.filhos('gUnidImob')).toEqual(['cCIB'])
    expect(d.texto('cCIB')).toBe('ABC12345')
    expect(d.texto('pCopropriedade')).toBe('50.00')
    expect(d.texto('vTotOper')).toBe('5000.00')
    expect(d.texto('vServ')).toBe('2500.00')
    expect(d.texto('cNBS')).toBe('110022000')
    expect(d.existe('dVencOrig')).toBe(false)
  })

  it('vários bens móveis; NBS informada da família 1.1101/1.1102; cIndOp 010103 pede o endereço do tomador (E0243)', async () => {
    const bens = [...BENS, { ncm: '84713012', descricao: 'Notebook', quantidade: '5' }]
    const xml = gerar(REGIMES.simples, LOC_R2, payloadMovel(bens, { nbs: '1.1101.50.00' }))
    expect(await errosXsd(xml, R2)).toEqual([])
    expect(doc(xml).texto('cNBS')).toBe('111015000')
    expect(xml.match(/<bensMoveis>/g)).toHaveLength(2)
    expect(() => gerar(REGIMES.simples, LOC_R2, payloadMovel(BENS, { c_ind_op: '010103' }))).toThrow(/endereço do tomador/)
    const comEndereco = payloadMovel(BENS, { c_ind_op: '010103' }, {
      tomador: { cnpj: '11222333000181', nome: 'Cliente', endereco: { cMun: '3550308', cep: '01310100', logradouro: 'Av Paulista', numero: '1000', bairro: 'Bela Vista' } },
    })
    expect(await errosXsd(gerar(REGIMES.simples, LOC_R2, comEndereco), R2)).toEqual([])
  })
})

describe('a DPS de locação não sai', () => {
  it('com a flag desligada, com a mensagem de que a Receita ainda não liberou', () => {
    for (const opcoes of [{ leiaute: 'nt009r2', ibscbs: false }, { leiaute: 'nt009r2', ibscbs: true, locacao: false }] as OpcoesDps[]) {
      expect(() => gerar(REGIMES.simples, opcoes, payloadImovel())).toThrow(MENSAGEM_LOCACAO_DESLIGADA)
      expect(() => gerar(REGIMES.simples, opcoes, payloadMovel())).toThrow(DpsInvalidError)
    }
  })

  it('no leiaute v1.01 (NT 004, produção até a virada): o grupo da locação não existe lá', () => {
    expect(() => gerar(REGIMES.simples, { leiaute: 'v1.01', ibscbs: false, locacao: true }, payloadImovel())).toThrow(/NT 009/)
  })

  it('com ISS retido (E0580), sem os dados do imóvel ou do bem, com NBS ou cIndOp fora da locação', () => {
    const issRetido = payloadImovel(IMOVEL, {
      tomador: { cnpj: '11222333000181', nome: 'X', endereco: { cMun: '3550308', cep: '01310100', logradouro: 'A', numero: '1', bairro: 'B' } },
      retencao: { iss: { aliquota: '5.00' } },
    })
    expect(() => gerar(REGIMES.simples, LOC_R2, issRetido)).toThrow(/não incidência/)
    expect(() => gerar(REGIMES.simples, LOC_R2, payloadImovel({ municipio_ibge: '3509502', residencial: true }))).toThrow(/dados do imóvel/)
    expect(() => gerar(REGIMES.simples, LOC_R2, payloadMovel([]))).toThrow(/NCM/)
    expect(() => gerar(REGIMES.simples, LOC_R2, payloadImovel(IMOVEL, { servico: { codigo_servico_nacional: LOCACAO_IMOVEL, descricao: 'x', nbs: '1.1502.10.00', locacao: { imovel: IMOVEL } } }))).toThrow(/1.1002/)
    expect(() => gerar(REGIMES.simples, LOC_R2, payloadImovel(IMOVEL, { servico: { codigo_servico_nacional: LOCACAO_IMOVEL, descricao: 'x', c_ind_op: '100301', locacao: { imovel: IMOVEL } } }))).toThrow(/02XXXX/)
    // Valor da nota que não bate com copropriedade × total (E0433).
    expect(() => gerar(REGIMES.simples, LOC_R2, payloadImovel({ ...IMOVEL, copropriedade: '50', valor_total: '4000.00' }))).toThrow(/50.00% do valor total/)
  })

  it('serviço comum não muda: a mesma DPS de antes, byte a byte, com e sem a flag', () => {
    const p = { tomador: { cpf: '12345678909', nome: 'Maria' }, servico: { codigo_servico_nacional: '040101', descricao: 'Consulta' }, valor: '100.00' }
    expect(gerar(REGIMES.simples, { leiaute: 'nt009r2', ibscbs: false }, p)).toBe(gerar(REGIMES.simples, LOC_R2, p))
    // Locação no payload de outro código é ignorada.
    const comLixo = { ...p, servico: { ...p.servico, locacao: { imovel: IMOVEL } } }
    expect(gerar(REGIMES.simples, LOC_R2, comLixo)).toBe(gerar(REGIMES.simples, LOC_R2, p))
  })
})

describe('flag e regras de leitura', () => {
  it('NOFISCAL_LOCACAO=1 liga; qualquer outro valor deixa desligada', () => {
    expect(opcoesDpsDoAmbiente({ ambiente: 'producao' }, {}).locacao).toBe(false)
    expect(opcoesDpsDoAmbiente({ ambiente: 'producao' }, { NOFISCAL_LOCACAO: 'true' }).locacao).toBe(false)
    expect(opcoesDpsDoAmbiente({ ambiente: 'producao_restrita' }, { NOFISCAL_LOCACAO: '1' }).locacao).toBe(true)
    expect(problemaDaLocacao({ codigo: LOCACAO_IMOVEL, locacao: null }, {})).toBe('LOCACAO_INDISPONIVEL')
    expect(problemaDaLocacao({ codigo: LOCACAO_IMOVEL, locacao: null }, { NOFISCAL_LOCACAO: '1' })).toBe('LOCACAO_SEM_DADOS')
    expect(problemaDaLocacao({ codigo: '040101', locacao: null }, {})).toBe(null)
  })

  it('lerLocacao diz o que falta do imóvel', () => {
    const r = lerLocacao({ imovel: { logradouro: 'Rua X' } }, LOCACAO_IMOVEL, '2500.00')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.faltando).toEqual(['municipio', 'cep', 'numero', 'residencial'])
    expect(lerLocacao(undefined, '040101', '1.00')).toEqual({ ok: true, locacao: null })
  })

  it('valor, copropriedade e arredondamento half even (E0433)', () => {
    expect(lerValor('2.500,00')).toBe('2500.00')
    expect(lerValor('2500')).toBe('2500.00')
    expect(lerValor('R$ 1.234,5')).toBe('1234.50')
    expect(lerValor('0')).toBe(null)
    expect(parteDoLocador('1000.00', '33.33')).toBe('333.30')
    expect(parteDoLocador('0.05', '50.00')).toBe('0.02') // 2,5 centavos → 2 (par)
    expect(parteDoLocador('0.07', '50.00')).toBe('0.04') // 3,5 centavos → 4 (par)
  })

  it('NBS do bem móvel pelo NCM', () => {
    expect(nbsDoBemMovel('87032310')).toBe('111011100')
    expect(nbsDoBemMovel('84713012')).toBe('111015000')
    expect(nbsDoBemMovel('94036000')).toBe('111023000')
    expect(nbsDoBemMovel('84799090')).toBe('111019000')
    expect(nbsDoBemMovel('39269090')).toBe('111029000')
  })

  it('resumo deixa claro que é locação; aviso do Simples na locação de imóvel', () => {
    const r = lerLocacao({ imovel: IMOVEL }, LOCACAO_IMOVEL, '2500.00')
    if (!r.ok || !r.locacao) throw new Error('esperava locação')
    const linhas = linhasDaLocacao(r.locacao)
    expect(linhas[0]).toBe('Tipo: locação de imóvel residencial (99.03.01), sem ISS')
    expect(linhas[1]).toBe('Imóvel: Rua das Flores, 120, apto 32 - Centro, CEP 13015-100, Campinas/SP')
    expect(avisosDaLocacao(LOCACAO_IMOVEL, 'simples')[0]).toMatch(/impeditiva do Simples/)
    expect(avisosDaLocacao(LOCACAO_IMOVEL, 'presumido')).toEqual([])
    expect(avisosDaLocacao(LOCACAO_MOVEL, 'mei')).toEqual([])
  })
})

describe('DANFSe da locação', () => {
  it('imóvel: bloco da locação, ISS não incidente e a classificação do IBS/CBS', async () => {
    const xml = gerar(REGIMES.simples, LOC_R2, payloadImovel())
    const nfse = testNfseXml({ dpsXml: xml, chave: '35503082256210013000140000000000001261100000000010', nNFSe: 77 })
    const lido = parseNfseXml(nfse)
    expect(lido.dps.ibscbs?.imovel?.vTotOper).toBe('2500.00')
    expect(lido.dps.ibscbs?.imovel?.unidades[0].endereco?.CEP).toBe('13015100')
    const texto = pdfTexts(await renderDanfse(nfse)).join(' ')
    expect(texto).toContain('LOCAÇÃO DE BEM IMÓVEL')
    expect(texto).toContain('Rua das Flores, 120, apto 32 - Centro - CEP 13015-100')
    expect(texto).toContain('3423.12.345.0001')
    expect(texto).toContain('Não incidência')
    expect(texto).toContain('200 / 200027')
  })

  it('bem móvel: NCM, descrição e quantidade', async () => {
    const xml = gerar(REGIMES.presumido, LOC_R2, payloadMovel())
    const nfse = testNfseXml({ dpsXml: xml, chave: '35503082256210013000140000000000001261100000000010', nNFSe: 78 })
    const texto = pdfTexts(await renderDanfse(nfse)).join(' ')
    expect(texto).toContain('LOCAÇÃO DE BEM MÓVEL')
    expect(texto).toContain('87032310')
    expect(texto).toContain('Automovel Onix 1.0')
  })
})
