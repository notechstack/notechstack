import { describe, expect, it } from 'vitest'
import { makeTestCertificate } from '../../_tests/certs.js'
import { verifySignature } from '../../_tests/verify-signature.js'
import { errosXsdNfe } from '../../_tests/xsd.js'
import { signXml } from '../xml-signer.js'
import { CODIGO_UF, UFS, type Uf } from './autorizadores.js'
import { MUNICIPIOS_IBGE } from './municipios-ibge.js'
import {
  avisosNfe,
  calcularTotais,
  creditoIcmsSn,
  dataHoraBrasilia,
  fraseCreditoSn,
  digitoChave,
  gtinValido,
  informacoesComplementaresDaNota,
  montarNfe,
  NfeInvalidaError,
  NOME_HOMOLOGACAO,
  resumoCreditoSn,
  validarNfe,
  type Item,
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

describe('regras da revisão de 17/11/2026', () => {
  it('indIntermed 0 com indPres 2/3/4/9 (NT 2020.006, rejeição 434); ausente com 0, 1 e 5', () => {
    expect(montarNfe(notaExemplo()).xml).toContain('<indPres>9</indPres><indIntermed>0</indIntermed><procEmi>')
    expect(montarNfe(notaExemplo({ presenca: '2' })).xml).toContain('<indPres>2</indPres><indIntermed>0</indIntermed>')
    expect(montarNfe(notaExemplo({ presenca: '1' })).xml).toContain('<indPres>1</indPres><procEmi>')
  })

  it('texto fora do Latin-1 vira equivalente ou sai (rejeição 225)', () => {
    const base = notaExemplo()
    const { xml } = montarNfe(notaExemplo({ itens: [{ ...base.itens[0], descricao: 'Farinha – “especial” 5kg… ☺' }], pagamentos: [{ forma: '17', valor: 59.7 }] }))
    expect(xml).toContain('<xProd>Farinha - &quot;especial&quot; 5kg...</xProd>')
  })

  it('série de 0 a 889 no web service (890+ dá rejeição 266)', () => {
    expect(validarNfe(notaExemplo({ serie: 890 }))).toContain('série de 0 a 889')
    expect(validarNfe(notaExemplo({ serie: 889 }))).toEqual([])
  })

  it('TAB e CR viram espaço; campo que só tem emoji conta como vazio', () => {
    const base = notaExemplo()
    const { xml } = montarNfe(notaExemplo({ itens: [{ ...base.itens[0], descricao: 'Farinha\ttipo\r1' }], pagamentos: [{ forma: '17', valor: 59.7 }] }))
    expect(xml).toContain('<xProd>Farinha tipo 1</xProd>')
    expect(validarNfe(notaExemplo({ itens: [{ ...base.itens[0], descricao: '\u{1F4E6}\u{1F4E6}' }], pagamentos: [{ forma: '17', valor: 59.7 }] }))).toContain('item 1: descrição obrigatória')
    const { xml: semCpl } = montarNfe(notaExemplo({ destinatario: { ...base.destinatario, endereco: { ...base.destinatario.endereco, complemento: '\u{1F642}' } } }))
    expect(semCpl).not.toContain('<xCpl>')
  })

  it('GTIN com dígito verificador GS1', () => {
    expect(gtinValido('7891234567895')).toBe(true)
    expect(gtinValido('7891234567890')).toBe(false)
    const base = notaExemplo()
    expect(validarNfe(notaExemplo({ itens: [{ ...base.itens[0], gtin: '7891234567890' }], pagamentos: [{ forma: '17', valor: 59.7 }] }))).toEqual([
      'item 1: GTIN inválido (8, 12, 13 ou 14 dígitos com o dígito verificador certo)',
    ])
  })

  it('destinatário isento (indIEDest 2) recusado em SP, aceito no RJ (rejeição 805)', () => {
    const base = notaExemplo()
    const isento = (uf: 'SP' | 'RJ', cMun: string) => notaExemplo({
      destinatario: { ...base.destinatario, indicadorIE: '2', endereco: { ...base.destinatario.endereco, uf, codigoMunicipio: cMun } },
      itens: base.itens.map((i) => ({ ...i, cfop: uf === 'SP' ? '5102' : '6102' })),
    })
    expect(validarNfe(isento('SP', '3550308'))[0]).toMatch(/não aceita contribuinte isento/)
    expect(validarNfe(isento('RJ', '3304557'))).toEqual([])
  })
})

describe('transporte e volumes (grupo transp)', () => {
  const transporte = {
    modalidadeFrete: '0' as const,
    transportador: {
      documento: '11.444.777/0001-61',
      nome: 'Transportadora Exemplo Ltda',
      inscricaoEstadual: '190.123.456.110',
      endereco: 'Rua das Cargas, 50 - Distrito Industrial',
      municipio: 'Atibaia',
      uf: 'sp',
    },
    volumes: [{ quantidade: 10, especie: 'CAIXA', marca: 'DAVI', numeracao: '1 a 10', pesoLiquido: 60.4, pesoBruto: 60.4 }],
  }
  const assinar = (xml: string) => {
    const cert = makeTestCertificate()
    return signXml({ xml, signedElement: 'infNFe', keyPem: cert.keyPem, certPem: cert.certPem, profile: 'sha1-c14n' })
  }

  it('sem os campos novos: só modFrete, como antes', () => {
    const { xml } = montarNfe(notaExemplo())
    expect(xml).toContain('<transp><modFrete>9</modFrete></transp>')
  })

  it('transportador e volumes completos, na ordem do leiaute', () => {
    const { xml } = montarNfe(notaExemplo(transporte))
    expect(xml).toContain(
      '<transp><modFrete>0</modFrete><transporta><CNPJ>11444777000161</CNPJ><xNome>Transportadora Exemplo Ltda</xNome>' +
        '<IE>190123456110</IE><xEnder>Rua das Cargas, 50 - Distrito Industrial</xEnder><xMun>Atibaia</xMun><UF>SP</UF></transporta>' +
        '<vol><qVol>10</qVol><esp>CAIXA</esp><marca>DAVI</marca><nVol>1 a 10</nVol><pesoL>60.400</pesoL><pesoB>60.400</pesoB></vol></transp>',
    )
  })

  it('transportador pessoa física, IE ISENTO e vários volumes', () => {
    const { xml } = montarNfe(notaExemplo({
      modalidadeFrete: '1',
      transportador: { documento: '529.982.247-25', nome: 'Joao Freteiro', inscricaoEstadual: 'isento' },
      volumes: [{ quantidade: 2, especie: 'PALETE' }, { quantidade: 0, pesoBruto: 1.5 }, { especie: '  ' }],
    }))
    expect(xml).toContain('<transporta><CPF>52998224725</CPF><xNome>Joao Freteiro</xNome><IE>ISENTO</IE></transporta>')
    expect(xml).toContain('<vol><qVol>2</qVol><esp>PALETE</esp></vol><vol><qVol>0</qVol><pesoB>1.500</pesoB></vol></transp>')
  })

  it('validação: documento, UF, peso, quantidade, modalidade', () => {
    const problemas = validarNfe(notaExemplo({
      modalidadeFrete: undefined,
      transportador: { documento: '11.444.777/0001-62', uf: 'XX', inscricaoEstadual: '1' },
      volumes: [{ quantidade: 1.5, pesoLiquido: -1, pesoBruto: 1.2345 }],
    }))
    expect(problemas).toEqual([
      'transportador informado: informe também a modalidade do frete (0 emitente, 1 destinatário, 2 terceiros, 3 próprio remetente, 4 próprio destinatário)',
      'transportador: CPF ou CNPJ inválido',
      'transportador: inscrição estadual de 2 a 14 dígitos (ou ISENTO)',
      'transportador: UF "XX" inválida',
      'volumes: quantidade de volumes deve ser um número inteiro, zero ou mais',
      'volumes: peso líquido deve ser zero ou mais, com até 3 casas (kg)',
      'volumes: peso bruto deve ser zero ou mais, com até 3 casas (kg)',
    ])
    expect(validarNfe(notaExemplo({ modalidadeFrete: '7' as never }))).toEqual(['modalidade do frete "7" inválida (0, 1, 2, 3, 4 ou 9)'])
  })

  it('aviso (não bloqueia): peso bruto menor que o líquido, sem frete com transportador', () => {
    const nota = notaExemplo({ modalidadeFrete: '9', transportador: { nome: 'Transp' }, volumes: [{ pesoLiquido: 10, pesoBruto: 9.5 }] })
    expect(validarNfe(nota)).toEqual([])
    expect(avisosNfe(nota)).toEqual([
      'volumes: peso bruto (9,5 kg) menor que o peso líquido (10 kg); confira',
      'transportador sem CPF ou CNPJ',
      'modalidade "sem frete" (9) com transportador informado; confira a modalidade',
    ])
    expect(avisosNfe(notaExemplo(transporte))).toEqual([])
  })

  it('XSD oficial (PL 010h v1.03): nota sem transporte, com transportador CNPJ e com CPF/ISENTO e vários volumes', async () => {
    const casos = [
      notaExemplo({ ambiente: 'producao' }),
      notaExemplo({ ...transporte, ambiente: 'producao' }),
      notaExemplo({
        modalidadeFrete: '4',
        transportador: { documento: '529.982.247-25', nome: 'Joao Freteiro', inscricaoEstadual: 'ISENTO', uf: 'MG' },
        volumes: [{ quantidade: 2, especie: 'PALETE', pesoLiquido: 0, pesoBruto: 1234.567 }, { numeracao: 'A1' }],
      }),
    ]
    for (const nota of casos) expect(await errosXsdNfe(assinar(montarNfe(nota).xml))).toEqual([])
  })
})

describe('frase do crédito do Simples (CSOSN 101) nas informações complementares', () => {
  const assinar = (xml: string) => {
    const cert = makeTestCertificate()
    return signXml({ xml, signedElement: 'infNFe', keyPem: cert.keyPem, certPem: cert.certPem, profile: 'sha1-c14n' })
  }
  const infCpl = (xml: string) => tag(xml, 'infCpl')
  const creditos = (xml: string) => [...xml.matchAll(/<vCredICMSSN>([\d.]+)<\/vCredICMSSN>/g)].map((m) => m[1])

  // NF-e 4081 da POLI BOX (planilha "POLI BOX - PLASDEPEL", 24/11/2026): 8 itens, R$ 1.178,75, CSOSN 101 a 2,84%.
  // Saiu com "R$ 0,00" na frase e foi cancelada. O texto abaixo é o da coluna `informacoes` daquela planilha.
  const TEXTO_4081 =
    'Documento emitido por ME ou EPP optante pelo Simples Nacional. Não gera direito a crédito fiscal de IPI. ' +
    'Permite o aproveitamento do crédito de ICMS no valor de R$ 0,00, correspondente à alíquota de 2,84%, nos termos do ' +
    'art. 23 da LC 123/2006. VENDA A VISTA - EM DINHEIRO'
  const caixa = (codigo: string, descricao: string, quantidade: number, valorUnitario: number): Item => ({
    codigo, descricao, ncm: '48191000', cfop: '5102', unidade: 'UN', quantidade, valorUnitario, origem: '0', csosn: '101', aliquotaCreditoSN: 2.84,
  })
  const ITENS_4081: Item[] = [
    caixa('1', 'CXB-24-15', 25, 4.3),
    caixa('2', 'CXB-34', 25, 4.6),
    caixa('3', 'CXB-20-15', 25, 4.2),
    caixa('4', 'CXB-26-15', 25, 4.4),
    caixa('5', 'CXB-32-15', 25, 5.65),
    caixa('6', 'CXB-41', 25, 4.3),
    caixa('7', 'CXB-41-15', 50, 6.1),
    caixa('8', 'CXB-49-15', 25, 7.5),
  ]
  const nota4081 = (texto: string | null = TEXTO_4081) =>
    notaExemplo({ itens: ITENS_4081, pagamentos: [{ forma: '01', valor: 1178.75 }], informacoesComplementares: texto })

  it('nota 4081: o crédito é a soma dos vCredICMSSN de cada item (R$ 33,47), não 2,84% do total (R$ 33,48)', () => {
    const { xml, totais } = montarNfe(nota4081())
    expect(totais.nota).toBe(117875)
    // Os mesmos valores que foram no XML real da nota 4081 (item 1: 3,05).
    expect(creditos(xml)).toEqual(['3.05', '3.27', '2.98', '3.12', '4.01', '3.05', '8.66', '5.33'])
    expect(creditoIcmsSn(ITENS_4081)).toEqual({ centavos: 3347, aliquotas: [2.84] })
    expect(Math.round(117875 * 0.0284)).toBe(3348) // a conta pelo total daria 1 centavo a mais
  })

  it('nota 4081: o "R$ 0,00" da planilha vira o crédito calculado e o resto do texto fica como estava', () => {
    const { xml } = montarNfe(nota4081())
    expect(infCpl(xml)).toBe(
      'Documento emitido por ME ou EPP optante pelo Simples Nacional. Não gera direito a crédito fiscal de IPI. ' +
        'Permite o aproveitamento do crédito de ICMS no valor de R$ 33,47, correspondente à alíquota de 2,84%, nos termos do ' +
        'art. 23 da LC 123/2006. VENDA A VISTA - EM DINHEIRO',
    )
    expect(infCpl(xml)).not.toContain('R$ 0,00')
  })

  it('nota 4081 passa no XSD do PL 010h (assinada), com e sem texto do usuário', async () => {
    for (const texto of [TEXTO_4081, null, 'VENDA A VISTA - EM DINHEIRO']) {
      expect(await errosXsdNfe(assinar(montarNfe(nota4081(texto)).xml))).toEqual([])
    }
  })

  it('valor e alíquota errados, sem acento e em maiúsculas: troca os dois e mantém as maiúsculas', () => {
    const texto = 'PERMITE O APROVEITAMENTO DO CREDITO DE ICMS NO VALOR DE R$1.234,56 CORRESPONDENTE A ALIQUOTA DE 4% NOS TERMOS DO ART. 23 DA LC 123/2006.'
    expect(infCpl(montarNfe(nota4081(texto)).xml)).toBe(
      'PERMITE O APROVEITAMENTO DO CRÉDITO DE ICMS NO VALOR DE R$ 33,47, CORRESPONDENTE À ALÍQUOTA DE 2,84% NOS TERMOS DO ART. 23 DA LC 123/2006.',
    )
  })

  it('texto sem a frase: a frase completa vai no início, antes do texto do usuário', () => {
    expect(infCpl(montarNfe(nota4081('VENDA A VISTA - EM DINHEIRO')).xml)).toBe(
      'Permite o aproveitamento do crédito de ICMS no valor de R$ 33,47, correspondente à alíquota de 2,84%, nos termos do ' +
        'art. 23 da LC 123/2006. VENDA A VISTA - EM DINHEIRO',
    )
  })

  it('sem texto nenhum: só a frase', () => {
    for (const texto of [null, '', '   ']) {
      expect(infCpl(montarNfe(nota4081(texto)).xml)).toBe(
        'Permite o aproveitamento do crédito de ICMS no valor de R$ 33,47, correspondente à alíquota de 2,84%, nos termos do art. 23 da LC 123/2006.',
      )
    }
  })

  it('alíquotas diferentes: o total e as alíquotas em ordem crescente', () => {
    const itens: Item[] = [
      { ...ITENS_4081[0], aliquotaCreditoSN: 3.95 }, // 107,50 × 3,95% = 4,25
      ITENS_4081[1], // 115,00 × 2,84% = 3,27
      { ...ITENS_4081[2], csosn: '102', aliquotaCreditoSN: null }, // fora do crédito
    ]
    expect(creditoIcmsSn(itens)).toEqual({ centavos: 752, aliquotas: [2.84, 3.95] })
    expect(resumoCreditoSn(itens)).toBe('R$ 7,52 (alíquotas de 2,84% e 3,95%)')
    const { xml } = montarNfe(notaExemplo({ itens, pagamentos: [{ forma: '01', valor: 2000 }], informacoesComplementares: TEXTO_4081 }))
    expect(infCpl(xml)).toContain('crédito de ICMS no valor de R$ 7,52, correspondente às alíquotas de 2,84% e 3,95%, nos termos')
  })

  it('nenhum item 101: o texto do usuário vai como está, até com a frase', () => {
    const itens: Item[] = ITENS_4081.map((i) => ({ ...i, csosn: '102', aliquotaCreditoSN: null }))
    expect(creditoIcmsSn(itens)).toBeNull()
    expect(resumoCreditoSn(itens)).toBeNull()
    expect(infCpl(montarNfe(notaExemplo({ itens, pagamentos: [{ forma: '01', valor: 2000 }], informacoesComplementares: TEXTO_4081 })).xml)).toBe(TEXTO_4081)
    expect(montarNfe(notaExemplo({ itens, pagamentos: [{ forma: '01', valor: 2000 }], informacoesComplementares: null })).xml).not.toContain('<infAdic>')
  })

  it('limite de 5.000 caracteres: a frase nunca é cortada; corta-se o texto do usuário', async () => {
    const longo = 'X'.repeat(6000)
    const semFrase = infCpl(montarNfe(nota4081(longo)).xml)!
    expect(semFrase).toHaveLength(5000)
    expect(semFrase.startsWith('Permite o aproveitamento do crédito de ICMS no valor de R$ 33,47, correspondente à alíquota de 2,84%')).toBe(true)
    expect(await errosXsdNfe(assinar(montarNfe(nota4081(longo)).xml))).toEqual([])

    // A frase no fim de um texto que passa do limite: sai de lá e vai para o início, inteira.
    const comFraseNoFim = infCpl(montarNfe(nota4081(`${'Y'.repeat(4990)} ${TEXTO_4081}`)).xml)!
    expect(comFraseNoFim).toHaveLength(5000)
    expect(comFraseNoFim.startsWith('Permite o aproveitamento do crédito de ICMS no valor de R$ 33,47')).toBe(true)
    expect(comFraseNoFim).not.toContain('R$ 0,00')
    expect(comFraseNoFim.match(/aproveitamento/g)).toHaveLength(1)
    expect(comFraseNoFim).not.toContain('nos termos do art. 23 da LC 123/2006. nos termos')

    // Rente ao limite, a troca no lugar ainda cabe (R$ 0,00 → R$ 33,47 soma 1 caractere).
    const justo = `${'Z'.repeat(5000 - TEXTO_4081.length - 2)} ${TEXTO_4081}`
    expect(justo).toHaveLength(4999)
    const r = infCpl(montarNfe(nota4081(justo)).xml)!
    expect(r).toHaveLength(5000)
    expect(r.startsWith('ZZZ')).toBe(true)
  })

  it('a mesma função para todos os canais: o pedido salvo (planilha, painel, WhatsApp, API) monta a mesma frase', () => {
    expect(informacoesComplementaresDaNota(TEXTO_4081, ITENS_4081)).toBe(infCpl(montarNfe(nota4081()).xml))
    expect(resumoCreditoSn(ITENS_4081)).toBe('R$ 33,47 (alíquota de 2,84%)')
    expect(fraseCreditoSn({ centavos: 123456, aliquotas: [1.25] })).toBe(
      'Permite o aproveitamento do crédito de ICMS no valor de R$ 1.234,56, correspondente à alíquota de 1,25%, nos termos do art. 23 da LC 123/2006.',
    )
  })
})
