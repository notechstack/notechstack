// Reforma Tributária na DPS: cNBS, grupo IBSCBS e os dois leiautes 1.01 (produção, XSD de 09/02/2026;
// NT 009 release 1, XSD da produção restrita de 20/10/2026). Todo XML é validado contra o XSD oficial.
import { DOMParser } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import { sharedTestCertificate } from '../_tests/certs.js'
import { errosXsd, type PacoteXsd } from '../_tests/xsd.js'
import { buildDps, DpsInvalidError, opcoesDpsDoAmbiente, parseNbs, type OpcoesDps } from './dps-builder.js'
import { pfxToPem } from './pfx.js'
import { resolverRtc } from './rtc/resolver.js'
import type { SefinTenant } from './sefin.js'
import { parseNewInvoice } from './validation.js'
import { signXml } from './xml-signer.js'

const NS = 'http://www.sped.fazenda.gov.br/nfse'
const PROD: PacoteXsd = 'producao-v1.01-20260209'
const PR: PacoteXsd = 'producao-restrita-20261020'

const tenant = (overrides: Partial<SefinTenant> = {}): SefinTenant => ({
  id: 't-1',
  cnpj: '56210013000140',
  razao_social: 'ESCRITORIO MODELO LTDA',
  inscricao_municipal: null,
  codigo_municipio_ibge: '3550308',
  regime: 'simples',
  ambiente: 'producao',
  p_tot_trib_sn: '6.00',
  ...overrides,
})

const payload = (servico: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  tomador: { cnpj: '11222333000181', nome: 'Cliente Tomador SA' },
  // 100401: uma NBS, um cIndOp e cClassTrib 000001 no Anexo VIII (resolve sozinho).
  servico: { codigo_servico_nacional: '100401', descricao: 'Agenciamento de contratos', ...servico },
  valor: '1500.00',
  ...extra,
})

const now = new Date('2026-11-17T13:00:00Z')
const V101: OpcoesDps = { leiaute: 'v1.01', ibscbs: false }
const NT009: OpcoesDps = { leiaute: 'nt009', ibscbs: false }

function gerar(opcoes: OpcoesDps | undefined, p: unknown = payload(), t: SefinTenant = tenant()) {
  return buildDps({ tenant: t, serie: '1', numero: 42, payload: p, now, opcoes })
}

function filhos(xml: string, nome: string): string[] {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  const no = doc.getElementsByTagNameNS(NS, nome)[0]
  return no ? Array.from(no.childNodes).map((n) => (n as Element).localName) : []
}

const texto = (xml: string, nome: string) =>
  Array.from(new DOMParser().parseFromString(xml, 'text/xml').getElementsByTagNameNS(NS, nome)).map((n) => n.textContent)

describe('DPS sem opções: a nota de produção de antes desta mudança', () => {
  it('sai igual, sem cNBS nem IBSCBS, válida no XSD de produção', async () => {
    const { xml } = gerar(undefined)
    expect(xml).toBe(gerar(V101).xml)
    expect(xml).not.toMatch(/cNBS|IBSCBS|finNFSe/)
    expect(await errosXsd(xml, PROD)).toEqual([])
  })

  it('é recusada pelo XSD da NT 009 (finNFSe obrigatório): por isso a produção restrita usa o nt009', async () => {
    const erros = await errosXsd(gerar(V101).xml, PR)
    expect(erros.join('\n')).toMatch(/finNFSe/)
  })
})

describe('leiaute nt009 (produção restrita desde 20/10/2026; produção prevista para 01/12/2026)', () => {
  it('põe finNFSe 0 depois de tpEmit e valida no XSD da produção restrita', async () => {
    const { xml } = gerar(NT009)
    expect(filhos(xml, 'infDPS').slice(6, 9)).toEqual(['tpEmit', 'finNFSe', 'cLocEmi'])
    expect(texto(xml, 'finNFSe')).toEqual(['0'])
    expect(await errosXsd(xml, PR)).toEqual([])
  })
})

describe('cNBS', () => {
  it('NBS informada na nota vai sempre, na posição de cada leiaute', async () => {
    const p = payload({ codigo_servico_nacional: '010101', descricao: 'Desenvolvimento de sistemas', nbs: '1.1502.10.00' })
    const v101 = gerar(V101, p).xml
    const nt009 = gerar(NT009, p).xml
    expect(filhos(v101, 'cServ')).toEqual(['cTribNac', 'xDescServ', 'cNBS'])
    expect(filhos(nt009, 'cServ')).toEqual(['cTribNac', 'cNBS', 'xDescServ'])
    expect(texto(v101, 'cNBS')).toEqual(['115021000'])
    expect(v101).not.toMatch(/IBSCBS/)
    expect(await errosXsd(v101, PROD)).toEqual([])
    expect(await errosXsd(nt009, PR)).toEqual([])
  })

  it('NBS da tabela só vai junto do IBSCBS', () => {
    expect(gerar(V101).xml).not.toMatch(/cNBS/)
    expect(texto(gerar({ ...V101, ibscbs: true }).xml, 'cNBS')).toEqual(['109059000'])
  })

  it('aceita com ou sem pontos e recusa NBS fora da lista nacional (E0316)', () => {
    expect(parseNbs('1.1502.10.00')).toBe('115021000')
    expect(parseNbs('115021000')).toBe('115021000')
    expect(parseNbs(undefined)).toBeNull()
    expect(() => parseNbs('1.1502.10')).toThrow(DpsInvalidError)
    expect(() => parseNbs('123456789')).toThrow(/lista nacional/)
    expect(() => gerar(V101, payload({ nbs: '123' }))).toThrow(/9 dígitos/)
  })
})

describe('NBS padrão da empresa (fiscal_tenants.nbs_padrao)', () => {
  // 010101 tem 11 NBS no Anexo VIII: sem a nota nem a empresa, a tabela não escolhe.
  const dev = (servico: Record<string, unknown> = {}) =>
    payload({ codigo_servico_nacional: '010101', descricao: 'Desenvolvimento', ...servico })
  const empresa = tenant({ nbs_padrao: '115021000' })

  it('ordem: servico.nbs da nota > padrão da empresa > Anexo VIII', () => {
    expect(gerar(V101, dev({ nbs: '1.1502.20.00' }), empresa).rtc.nbs).toEqual({ codigo: '115022000', origem: 'nota' })
    expect(gerar(V101, dev(), empresa).rtc.nbs).toEqual({ codigo: '115021000', origem: 'empresa' })
    // 100401 resolve pela tabela (109059000), mas o padrão da empresa vem antes.
    expect(gerar(V101, payload(), empresa).rtc.nbs).toEqual({ codigo: '115021000', origem: 'empresa' })
    expect(gerar(V101, payload(), tenant()).rtc.nbs).toEqual({ codigo: '109059000', origem: 'tabela' })
  })

  it('flags desligadas: só leva o cNBS, válido nos dois leiautes', async () => {
    const v101 = gerar(V101, dev(), empresa).xml
    const nt009 = gerar(NT009, dev(), empresa).xml
    expect(texto(v101, 'cNBS')).toEqual(['115021000'])
    expect(v101).not.toMatch(/IBSCBS/)
    expect(v101).toBe(gerar(V101, dev({ nbs: '115021000' })).xml)
    expect(await errosXsd(v101, PROD)).toEqual([])
    expect(await errosXsd(nt009, PR)).toEqual([])
  })

  it('com o IBSCBS ligado, a NBS da empresa destrava o grupo do código que a tabela não resolve', async () => {
    const opcoes: OpcoesDps = { leiaute: 'nt009', ibscbs: true }
    expect(gerar(opcoes, dev()).rtc.ibscbs).toEqual({ falta: 'NBS' })
    const { xml, rtc } = gerar(opcoes, dev(), tenant({ nbs_padrao: '115021000', ambiente: 'producao_restrita' }))
    expect(rtc.nbs).toEqual({ codigo: '115021000', origem: 'empresa' })
    expect(texto(xml, 'cNBS')).toEqual(['115021000'])
    expect(filhos(xml, 'infDPS').at(-1)).toBe('IBSCBS')
    expect(await errosXsd(xml, PR)).toEqual([])
  })

  it('sem padrão, ou padrão fora da lista atual, a DPS sai como antes', () => {
    expect(gerar(V101, dev(), tenant({ nbs_padrao: null })).xml).toBe(gerar(V101, dev()).xml)
    expect(gerar(V101, dev(), tenant({ nbs_padrao: '123456789' })).xml).toBe(gerar(V101, dev()).xml)
  })
})

describe('grupo IBSCBS (Simples e MEI, opcional em 2026)', () => {
  it('leiaute de produção: finNFSe, cIndOp, indDest e gIBSCBS com CST/cClassTrib; válido no XSD', async () => {
    const { xml, rtc } = gerar({ leiaute: 'v1.01', ibscbs: true })
    expect(rtc).toEqual({
      nbs: { codigo: '109059000', origem: 'tabela' },
      ibscbs: { cIndOp: '100301', cst: '000', cClassTrib: '000001' },
    })
    expect(filhos(xml, 'infDPS').at(-1)).toBe('IBSCBS')
    expect(filhos(xml, 'IBSCBS')).toEqual(['finNFSe', 'cIndOp', 'indDest', 'valores'])
    expect(filhos(xml, 'gIBSCBS')).toEqual(['CST', 'cClassTrib'])
    expect(texto(xml, 'indDest')).toEqual(['0'])
    expect(await errosXsd(xml, PROD)).toEqual([])
  })

  it('leiaute nt009: CST/cClassTrib direto em trib, finNFSe na raiz; válido no XSD da produção restrita', async () => {
    const { xml } = gerar({ leiaute: 'nt009', ibscbs: true })
    expect(filhos(xml, 'IBSCBS')).toEqual(['cIndOp', 'indDest', 'valores'])
    const trib = filhos(xml, 'IBSCBS').length && xml.match(/<IBSCBS>.*<\/IBSCBS>/)?.[0]
    expect(trib).toContain('<trib><CST>000</CST><cClassTrib>000001</cClassTrib></trib>')
    expect(xml).not.toMatch(/gIBSCBS/)
    expect(await errosXsd(xml, PR)).toEqual([])
  })

  it('sem NBS resolvida, a DPS sai sem o grupo (tudo ou nada: E0322) e diz o que faltou', async () => {
    // 010101 tem 11 NBS possíveis no Anexo VIII: a tabela não escolhe.
    const p = payload({ codigo_servico_nacional: '010101', descricao: 'Desenvolvimento' })
    const { xml, rtc } = gerar({ leiaute: 'v1.01', ibscbs: true }, p)
    expect(rtc.ibscbs).toEqual({ falta: 'NBS' })
    expect(xml).not.toMatch(/IBSCBS|cNBS/)
    expect(await errosXsd(xml, PROD)).toEqual([])
  })

  it('NBS, cIndOp e cClassTrib informados mandam sobre a tabela', () => {
    const p = payload({
      codigo_servico_nacional: '010101',
      descricao: 'Desenvolvimento',
      nbs: '115021000',
      c_class_trib: '200043',
    })
    const { xml } = gerar({ leiaute: 'v1.01', ibscbs: true }, p)
    expect(texto(xml, 'cIndOp')).toEqual(['100301'])
    expect(texto(xml, 'CST')).toEqual(['200'])
    expect(texto(xml, 'cClassTrib')).toEqual(['200043'])
  })

  it('cClassTrib: o único da linha, ou 000001 entre várias opções; sem isso, fica para a nota', () => {
    expect(resolverRtc('171901', { nbs: '113022100', cIndOp: null, cClassTrib: null }).ibscbs).toEqual({
      cIndOp: '100301',
      cst: '200',
      cClassTrib: '200052',
    })
    // 040101 (Medicina): três cIndOp possíveis no Anexo VIII.
    expect(resolverRtc('040101', { nbs: null, cIndOp: null, cClassTrib: null }).ibscbs).toEqual({ falta: 'cIndOp' })
    expect(resolverRtc('990101', { nbs: null, cIndOp: null, cClassTrib: null }).ibscbs).toEqual({
      falta: 'NBS, cIndOp, cClassTrib',
    })
  })

  it('MEI com retenção nenhuma e Simples com ISS retido: grupo junto do resto, assinado, válido nos dois XSD', async () => {
    const cert = sharedTestCertificate()
    const pem = pfxToPem(cert.certificado)
    const endereco = { cMun: '3550308', cep: '01001000', logradouro: 'Praça da Sé', numero: '1', bairro: 'Sé' }
    const casos: Array<[SefinTenant, unknown]> = [
      [tenant({ regime: 'mei', p_tot_trib_sn: null }), payload()],
      [
        tenant(),
        payload({}, {
          tomador: { cnpj: '11222333000181', nome: 'Cliente Tomador SA', endereco },
          retencao: { iss: { aliquota: '2.00' }, inss: { valor: '100.00' } },
        }),
      ],
    ]
    for (const [t, p] of casos) {
      for (const [leiaute, pacote] of [['v1.01', PROD], ['nt009', PR]] as const) {
        const { xml } = gerar({ leiaute, ibscbs: true }, p, t)
        expect(xml).toMatch(/<IBSCBS>/)
        const assinado = signXml({ xml, signedElement: 'infDPS', keyPem: pem.keyPem, certPem: pem.certPem })
        expect(await errosXsd(assinado, pacote), `${t.regime} ${leiaute}`).toEqual([])
      }
    }
  })
})

describe('opções pelo ambiente', () => {
  it('produção restrita usa nt009; produção só com NOFISCAL_DPS_LEIAUTE=nt009; IBSCBS só com NOFISCAL_DPS_IBSCBS=1', () => {
    expect(opcoesDpsDoAmbiente({ ambiente: 'producao' }, {})).toEqual({ leiaute: 'v1.01', ibscbs: false })
    expect(opcoesDpsDoAmbiente({ ambiente: 'producao_restrita' }, {})).toEqual({ leiaute: 'nt009', ibscbs: false })
    expect(opcoesDpsDoAmbiente({ ambiente: 'producao' }, { NOFISCAL_DPS_LEIAUTE: 'nt009' }).leiaute).toBe('nt009')
    expect(opcoesDpsDoAmbiente({ ambiente: 'producao' }, { NOFISCAL_DPS_IBSCBS: '1' }).ibscbs).toBe(true)
    expect(opcoesDpsDoAmbiente({ ambiente: 'producao' }, { NOFISCAL_DPS_IBSCBS: 'true' }).ibscbs).toBe(false)
  })
})

describe('API /v1/nfse', () => {
  const corpo = (servico: Record<string, unknown>) => ({
    external_id: 'x-1',
    tomador: { cpf: '12345678909', nome: 'Maria' },
    servico: { codigo_servico_nacional: '010101', descricao: 'Sistema', ...servico },
    valor: '10.00',
  })

  it('aceita nbs (normalizada), c_ind_op e c_class_trib', () => {
    const r = parseNewInvoice(corpo({ nbs: '1.1502.10.00', c_ind_op: '100301', c_class_trib: '000001' }))
    expect(r.ok && r.value.servico).toEqual({
      codigo: '010101',
      descricao: 'Sistema',
      nbs: '115021000',
      c_ind_op: '100301',
      c_class_trib: '000001',
    })
  })

  it('sem os campos novos, o payload fica como antes', () => {
    const r = parseNewInvoice(corpo({}))
    expect(r.ok && r.value.servico).toEqual({ codigo: '010101', descricao: 'Sistema' })
  })

  it('recusa NBS inválida e códigos fora do formato', () => {
    expect(parseNewInvoice(corpo({ nbs: '123456789' }))).toMatchObject({ ok: false, message: /servico.nbs/ })
    expect(parseNewInvoice(corpo({ c_class_trib: '1' }))).toMatchObject({ ok: false, message: /c_class_trib/ })
  })
})
