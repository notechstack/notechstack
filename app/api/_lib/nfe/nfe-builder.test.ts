import { describe, expect, it } from 'vitest'
import { makeTestCertificate } from '../../_tests/certs.js'
import { verifySignature } from '../../_tests/verify-signature.js'
import { signXml } from '../xml-signer.js'
import { CODIGO_UF, UFS, type Uf } from './autorizadores.js'
import { MUNICIPIOS_IBGE } from './municipios-ibge.js'
import {
  calcularTotais,
  dataHoraBrasilia,
  digitoChave,
  montarNfe,
  NfeInvalidaError,
  NOME_HOMOLOGACAO,
  validarNfe,
} from './nfe-builder.js'
import { notaExemplo } from './nfe-fixtures.js'

const tag = (xml: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1]

describe('chave de acesso', () => {
  it('dígito verificador do exemplo do Manual de Orientação do Contribuinte', () => {
    expect(digitoChave('5206043300991100250655012000000780026730161')).toBe('5')
  })

  it('44 dígitos: UF, AAMM, CNPJ, modelo 55, série, número, tpEmis, cNF e DV', () => {
    const { chave, id } = montarNfe(notaExemplo())
    expect(chave).toMatch(/^\d{44}$/)
    expect(chave.slice(0, 2)).toBe('35')
    expect(chave.slice(2, 6)).toBe('2611')
    expect(chave.slice(6, 20)).toBe('12345678000195')
    expect(chave.slice(20, 22)).toBe('55')
    expect(chave.slice(22, 25)).toBe('001')
    expect(chave.slice(25, 34)).toBe('000000042')
    expect(chave.slice(34, 35)).toBe('1')
    expect(chave.slice(35, 43)).toBe('12345678')
    expect(chave.slice(43)).toBe(digitoChave(chave.slice(0, 43)))
    expect(id).toBe(`NFe${chave}`)
  })
})

describe('montarNfe', () => {
  it('totais em centavos exatos (sem erro de ponto flutuante)', () => {
    const t = calcularTotais(notaExemplo().itens)
    // 3 × 19,90 = 59,70; 2,5 × 12,345 = 30,8625 → 30,86; desconto 1,00
    expect(t).toEqual({ produtos: 9056, frete: 0, seguro: 0, desconto: 100, outros: 0, nota: 8956 })
    const { xml } = montarNfe(notaExemplo())
    expect(tag(xml, 'vNF')).toBe('89.56')
    expect(xml).toContain('<vUnCom>12.345</vUnCom>')
    expect(xml).toContain('<qCom>2.5000</qCom>')
    expect(xml).toContain('<vTroco>10.44</vTroco>')
  })

  it('CSOSN 101 leva o crédito do Simples; 102 só origem e CSOSN', () => {
    const { xml } = montarNfe(notaExemplo())
    expect(xml).toContain('<ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102>')
    expect(xml).toContain('<ICMSSN101><orig>0</orig><CSOSN>101</CSOSN><pCredSN>1.25</pCredSN><vCredICMSSN>0.39</vCredICMSSN></ICMSSN101>')
    expect(xml).toContain('<PISOutr><CST>49</CST><vBC>0.00</vBC><pPIS>0.0000</pPIS><vPIS>0.00</vPIS></PISOutr>')
  })

  it('homologação troca o nome do destinatário; produção mantém', () => {
    expect(tag(montarNfe(notaExemplo()).xml, 'xNome')).toBe('Comercio Exemplo Braganca Ltda')
    expect(montarNfe(notaExemplo()).xml).toContain(`<xNome>${NOME_HOMOLOGACAO}</xNome>`)
    const prod = montarNfe(notaExemplo({ ambiente: 'producao' })).xml
    expect(prod).toContain('<xNome>Padaria Exemplo Ltda</xNome>')
    expect(prod).toContain('<tpAmb>1</tpAmb>')
  })

  it('município pelo código IBGE, com o nome oficial', () => {
    const { xml } = montarNfe(notaExemplo())
    expect(xml).toContain('<cMun>3507605</cMun><xMun>Bragança Paulista</xMun><UF>SP</UF><CEP>12900000</CEP>')
    expect(xml).toContain('<cMun>3550308</cMun><xMun>São Paulo</xMun>')
  })

  it('dhEmi no fuso de Brasília', () => {
    expect(dataHoraBrasilia(new Date('2026-11-16T15:30:00Z'))).toBe('2026-11-16T12:30:00-03:00')
  })

  it('não contribuinte vira consumidor final; contribuinte com IE leva a IE', () => {
    expect(tag(montarNfe(notaExemplo()).xml, 'indFinal')).toBe('1')
    const base = notaExemplo()
    const contrib = montarNfe(
      notaExemplo({ destinatario: { ...base.destinatario, indicadorIE: '1', inscricaoEstadual: '110.042.490.114' } }),
    ).xml
    expect(tag(contrib, 'indFinal')).toBe('0')
    expect(contrib).toContain('<indIEDest>1</indIEDest><IE>110042490114</IE>')
  })

  it('assinatura rsa-sha1 com c14n sobre o infNFe, verificável', () => {
    const cert = makeTestCertificate()
    const { xml, id } = montarNfe(notaExemplo())
    const assinado = signXml({ xml, signedElement: 'infNFe', keyPem: cert.keyPem, certPem: cert.certPem, profile: 'sha1-c14n' })
    expect(assinado).toContain(`<Reference URI="#${id}">`)
    expect(assinado).toContain('Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"')
    expect(assinado).toContain('Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"')
    expect(assinado).toMatch(/<\/infNFe><Signature xmlns="http:\/\/www.w3.org\/2000\/09\/xmldsig#">/)
    expect(verifySignature(assinado, cert.certPem)).toBe(true)
  })
})

describe('todas as UFs', () => {
  // Uma capital de cada UF, pelo código IBGE.
  const CAPITAL: Record<Uf, string> = {
    RO: '1100205', AC: '1200401', AM: '1302603', RR: '1400100', PA: '1501402', AP: '1600303', TO: '1721000',
    MA: '2111300', PI: '2211001', CE: '2304400', RN: '2408102', PB: '2507507', PE: '2611606', AL: '2704302',
    SE: '2800308', BA: '2927408', MG: '3106200', ES: '3205309', RJ: '3304557', SP: '3550308', PR: '4106902',
    SC: '4205407', RS: '4314902', MS: '5002704', MT: '5103403', GO: '5208707', DF: '5300108',
  }

  it('a tabela do IBGE tem os 5.571 municípios e cada um começa pelo código da sua UF', () => {
    const codigos = Object.keys(MUNICIPIOS_IBGE)
    expect(codigos).toHaveLength(5571)
    const ufs = new Set(Object.values(CODIGO_UF))
    for (const c of codigos) expect(ufs.has(c.slice(0, 2))).toBe(true)
  })

  for (const uf of UFS) {
    it(`emitente em ${uf}: interna com 5102 e interestadual com 6102`, () => {
      const base = notaExemplo()
      const emitente = { ...base.emitente, endereco: { ...base.emitente.endereco, uf, codigoMunicipio: CAPITAL[uf] } }
      const destinoInterno = { ...base.destinatario, endereco: { ...base.destinatario.endereco, uf, codigoMunicipio: CAPITAL[uf] } }
      const interna = montarNfe(notaExemplo({ emitente, destinatario: destinoInterno }))
      expect(interna.chave.slice(0, 2)).toBe(CODIGO_UF[uf])
      expect(tag(interna.xml, 'idDest')).toBe('1')

      const outra: Uf = uf === 'SP' ? 'MG' : 'SP'
      const destinoFora = { ...base.destinatario, endereco: { ...base.destinatario.endereco, uf: outra, codigoMunicipio: CAPITAL[outra] } }
      const itens = base.itens.map((i) => ({ ...i, cfop: '6102' }))
      const inter = montarNfe(notaExemplo({ emitente, destinatario: destinoFora, itens }))
      expect(tag(inter.xml, 'idDest')).toBe('2')
    })
  }
})

describe('validarNfe', () => {
  it('nota de exemplo passa', () => {
    expect(validarNfe(notaExemplo())).toEqual([])
  })

  it('aponta cada problema em português', () => {
    const base = notaExemplo()
    const problemas = validarNfe(
      notaExemplo({
        emitente: { ...base.emitente, inscricaoEstadual: '' },
        destinatario: { ...base.destinatario, endereco: { ...base.destinatario.endereco, codigoMunicipio: '3106200' } },
        itens: [{ ...base.itens[0], ncm: '123', cfop: '6102', quantidade: 0 }],
        pagamentos: [],
      }),
    )
    expect(problemas).toEqual(
      expect.arrayContaining([
        'emitente: inscrição estadual obrigatória para NF-e',
        'destinatário: município 3106200 não é de SP',
        'item 1: NCM deve ter 8 dígitos',
        'item 1: operação dentro do estado pede CFOP 5xxx',
        'item 1: quantidade deve ser maior que zero',
        'informe a forma de pagamento',
      ]),
    )
  })

  it('pagamento menor que o total é barrado', () => {
    expect(validarNfe(notaExemplo({ pagamentos: [{ forma: '01', valor: 50 }] }))).toEqual([
      'pagamento (R$ 50.00) menor que o total da nota (R$ 89.56)',
    ])
  })

  it('montarNfe lança NfeInvalidaError com a lista', () => {
    expect(() => montarNfe(notaExemplo({ itens: [] }))).toThrow(NfeInvalidaError)
  })
})
