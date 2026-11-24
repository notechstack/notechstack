// Natureza da operação (bug da NF-e 2232 da Bragantina, 24/11/2026): remessa CFOP 6949 saía como "Venda de mercadoria" e
// com pagamento PIX. A natureza sai do CFOP (ou da informada) e a nota sem venda sai "sem pagamento" (tPag 90).
import { describe, expect, it } from 'vitest'
import { makeTestCertificate } from '../../_tests/certs.js'
import { pdfTexts } from '../../_tests/pdf-text.js'
import { errosXsdNfe } from '../../_tests/xsd.js'
import { signXml } from '../xml-signer.js'
import { lerPedidoNfe } from '../parceiro/nfe-api.js'
import { pedidoDoEstado, perguntaDaNatureza } from '../agente/nfe-conversa.js'
import { renderDanfe } from './danfe.js'
import { avisosNfe, montarNfe, validarNfe, type Item, type NfeInput } from './nfe-builder.js'
import { notaExemplo } from './nfe-fixtures.js'
import { formaPadrao, naturezaDaNota, naturezaDoCfop } from './natureza.js'
import { interpretarPlanilhaNfe } from './planilha.js'
import { nfeProc } from './sefaz-client.js'

const cert = makeTestCertificate()
const assinar = (xml: string) => signXml({ xml, signedElement: 'infNFe', keyPem: cert.keyPem, certPem: cert.certPem, profile: 'sha1-c14n' })
const tag = (xml: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1]
const item = (cfop: string, over: Partial<Item> = {}): Item => ({
  codigo: '1', descricao: 'GARRAFA VERMELHA BRILHA', ncm: '96170010', cfop, unidade: 'UN', quantidade: 9, valorUnitario: 40.29, origem: '0', csosn: '400', ...over,
})

/** A NF-e 2232: remessa SP → RJ, CFOP 6949, CSOSN 400, para uma pessoa física, por conta e ordem. */
function remessa2232(over: Partial<NfeInput> = {}): NfeInput {
  return notaExemplo({
    ambiente: 'producao',
    destinatario: {
      documento: '529.982.247-25',
      nome: 'Cliente Pessoa Fisica',
      indicadorIE: '9',
      endereco: { logradouro: 'Rua Exemplo', numero: '10', bairro: 'Centro', codigoMunicipio: '3304557', uf: 'RJ', cep: '20040-020' },
    },
    itens: [item('6949')],
    modalidadeFrete: '0',
    pagamentos: [{ forma: '90', valor: 0 }],
    informacoesComplementares: 'ENTREGUE POR CONTA E ORDEM DE TERCEIRO, CONFORME NF 2183.',
    ...over,
  })
}

describe('tabela de natureza pelo CFOP', () => {
  it('5xxx e 6xxx têm a mesma natureza', () => {
    for (const [cfop, natureza] of [
      ['5102', 'Venda de mercadoria'], ['6102', 'Venda de mercadoria'], ['6108', 'Venda de mercadoria'], ['5101', 'Venda de mercadoria'],
      ['5949', 'Simples remessa'], ['6949', 'Simples remessa'],
      ['5910', 'Remessa em bonificação, doação ou brinde'], ['6911', 'Remessa de amostra grátis'], ['5915', 'Remessa para conserto'],
      ['6923', 'Remessa por conta e ordem de terceiros'], ['5202', 'Devolução de compra'], ['6152', 'Transferência de mercadoria'],
    ]) expect(naturezaDoCfop(cfop)?.natureza).toBe(natureza)
    expect(naturezaDoCfop('6.949')?.tipo).toBe('remessa')
    expect(naturezaDoCfop('5933')).toBeNull()
    expect(naturezaDoCfop('7102')).toBeNull()
  })

  it('remessa 6949: "Simples remessa", sem venda, sem aviso', () => {
    expect(naturezaDaNota([item('6949')])).toEqual({ natureza: 'Simples remessa', origem: 'cfop', semVenda: true, avisos: [] })
    expect(formaPadrao([item('6949')], '17')).toBe('90')
    expect(formaPadrao([item('5102')], '17')).toBe('17')
  })

  it('a informada vale sobre o CFOP (sem espaços sobrando)', () => {
    expect(naturezaDaNota([item('6949')], '  Remessa  por conta e ordem ')).toMatchObject({ natureza: 'Remessa por conta e ordem', origem: 'informada', semVenda: true })
    expect(naturezaDaNota([item('6949')], '   ').origem).toBe('cfop')
  })

  it('nota mista: a venda prevalece; sem venda, a do primeiro item; os dois avisam', () => {
    const vendaComBrinde = naturezaDaNota([item('5910'), item('5102')])
    expect(vendaComBrinde).toMatchObject({ natureza: 'Venda de mercadoria', semVenda: false })
    expect(vendaComBrinde.avisos).toEqual([
      'natureza da operação: itens de naturezas diferentes (Remessa em bonificação, doação ou brinde (CFOP 5910); Venda de mercadoria (CFOP 5102)); a nota sai como "Venda de mercadoria". Se não for isso, informe a natureza da operação',
    ])
    const remessas = naturezaDaNota([item('5911'), item('5910')])
    expect(remessas).toMatchObject({ natureza: 'Remessa de amostra grátis', semVenda: true })
    expect(remessas.avisos).toHaveLength(1)
    // Informada: sem aviso.
    expect(naturezaDaNota([item('5911'), item('5910')], 'Remessa de brindes e amostras').avisos).toEqual([])
  })

  it('CFOP fora da tabela: "Venda de mercadoria", como antes, com aviso; pagamento padrão da venda', () => {
    const n = naturezaDaNota([item('5933')])
    expect(n).toMatchObject({ natureza: 'Venda de mercadoria', origem: 'padrao', semVenda: false })
    expect(n.avisos[0]).toMatch(/CFOP 5933 não está na tabela/)
    expect(formaPadrao([item('5933')], '17')).toBe('17')
    expect(formaPadrao([item('5949'), item('5933')], '17')).toBe('17')
  })
})

describe('natOp no XML', () => {
  it('derivado do CFOP: 6949 → Simples remessa; 5102 → Venda de mercadoria', () => {
    expect(tag(montarNfe(remessa2232()).xml, 'natOp')).toBe('Simples remessa')
    expect(tag(montarNfe(notaExemplo()).xml, 'natOp')).toBe('Venda de mercadoria')
  })

  it('informado: vai como veio', () => {
    expect(tag(montarNfe(remessa2232({ naturezaOperacao: 'Remessa por conta e ordem de terceiros' })).xml, 'natOp')).toBe('Remessa por conta e ordem de terceiros')
  })

  it('a remessa 2232 sai com tPag 90 e vPag 0, e passa no XSD do PL 010h (assinada)', async () => {
    const { xml } = montarNfe(remessa2232())
    expect(xml).toContain('<pag><detPag><tPag>90</tPag><vPag>0.00</vPag></detPag></pag>')
    expect(tag(xml, 'CFOP')).toBe('6949')
    expect(tag(xml, 'idDest')).toBe('2')
    expect(tag(xml, 'indFinal')).toBe('1')
    expect(await errosXsdNfe(assinar(xml))).toEqual([])
    expect(await errosXsdNfe(assinar(montarNfe(remessa2232({ naturezaOperacao: 'Remessa por conta e ordem de terceiros' })).xml))).toEqual([])
  })

  it('natureza com mais de 60 caracteres é recusada', () => {
    expect(validarNfe(remessa2232({ naturezaOperacao: 'x'.repeat(61) }))).toContain('natureza da operação: até 60 caracteres')
    expect(validarNfe(remessa2232({ naturezaOperacao: 'x'.repeat(60) }))).toEqual([])
  })

  it('avisos: remessa com pagamento informado; mista; venda normal sem aviso', () => {
    expect(avisosNfe(remessa2232({ pagamentos: [{ forma: '17', valor: 362.61 }] }))).toEqual([
      '"Simples remessa" é uma operação sem venda, mas a nota tem forma de pagamento; numa remessa, o comum é "sem pagamento" (90)',
    ])
    expect(avisosNfe(remessa2232())).toEqual([])
    expect(avisosNfe(notaExemplo())).toEqual([])
    expect(avisosNfe(notaExemplo({ itens: [item('5910'), item('5102')] }))).toHaveLength(1)
  })
})

describe('DANFE', () => {
  it('mostra a natureza da operação da remessa', async () => {
    const { xml, chave } = montarNfe(remessa2232())
    const prot =
      `<protNFe versao="4.00"><infProt><tpAmb>1</tpAmb><verAplic>SP</verAplic><chNFe>${chave}</chNFe>` +
      `<dhRecbto>2026-11-24T17:35:05-03:00</dhRecbto><nProt>135260000012345</nProt><digVal>x</digVal><cStat>100</cStat><xMotivo>Autorizado</xMotivo></infProt></protNFe>`
    const textos = pdfTexts(await renderDanfe(nfeProc(assinar(xml), prot))).join('\n')
    expect(textos).toContain('Simples remessa')
    expect(textos).not.toContain('Venda de mercadoria')
  })
})

describe('planilha: coluna natureza_operacao', () => {
  const CAB = ['cnpj_emitente', 'nota', 'cpf_cnpj_destinatario', 'nome_destinatario', 'cep', 'logradouro', 'numero', 'bairro', 'municipio_ibge', 'uf',
    'codigo_produto', 'descricao_produto', 'ncm', 'cfop', 'unidade', 'quantidade', 'valor_unitario', 'csosn', 'forma_pagamento', 'natureza_operacao']
  const linha = (nota: string, cfop: string, forma: string, natureza: string, codigo = '1') =>
    ['12.345.678/0001-95', nota, '529.982.247-25', 'Cliente PF', '20040-020', 'Rua Exemplo', '10', 'Centro', '3304557', 'RJ',
      codigo, 'GARRAFA', '9617.00.10', cfop, 'UN', '9', '40,29', '400', forma, natureza]

  it('remessa 6949 sem natureza nem forma: natureza do CFOP e "sem pagamento" (90, valor 0)', () => {
    const r = interpretarPlanilhaNfe([CAB, linha('2232', '6949', '', '')])
    expect(r.ok && r.problemas).toEqual([])
    if (!r.ok) return
    const p = r.notas[0].pedido
    expect(p.pagamentos).toEqual([{ forma: '90', valor: 0, descricao: null }])
    expect('naturezaOperacao' in p).toBe(false)
    expect(naturezaDaNota(p.itens, p.naturezaOperacao).natureza).toBe('Simples remessa')
    expect(r.notas[0].avisos).toEqual([])
  })

  it('venda sem forma continua PIX; sem a coluna, o pedido não muda', () => {
    const r = interpretarPlanilhaNfe([CAB.slice(0, -1), linha('1', '6102', '', '').slice(0, -1)])
    expect(r.ok && r.notas[0].pedido.pagamentos[0].forma).toBe('17')
    expect(r.ok && 'naturezaOperacao' in r.notas[0].pedido).toBe(false)
  })

  it('natureza informada (repetida igual, sem caixa nem acento) vai ao pedido', () => {
    const r = interpretarPlanilhaNfe([
      CAB,
      linha('7', '6949', '', 'Remessa por conta e ordem de terceiros'),
      linha('7', '6949', '', 'REMESSA POR CONTA E ORDEM DE TERCEIROS', '2'),
      linha('7', '6949', '', '', '3'),
    ])
    expect(r.ok && r.problemas).toEqual([])
    expect(r.ok && r.notas[0].pedido.naturezaOperacao).toBe('Remessa por conta e ordem de terceiros')
  })

  it('natureza diferente na mesma nota recusa a nota', () => {
    const r = interpretarPlanilhaNfe([CAB, linha('8', '6949', '', 'Simples remessa'), linha('8', '6949', '', 'Remessa de brinde', '2')])
    expect(r.ok && r.notas).toEqual([])
    expect(r.ok && r.problemas.map((p) => p.mensagem)).toEqual(['linha 3: "natureza_operacao" diferente da linha 2'])
  })

  it('natureza com mais de 60 caracteres recusa a nota', () => {
    const r = interpretarPlanilhaNfe([CAB, linha('9', '6949', '', 'x'.repeat(61))])
    expect(r.ok && r.problemas.map((p) => p.mensagem)).toEqual(['natureza_operacao com mais de 60 caracteres'])
  })

  it('remessa com PIX na coluna: sai PIX, com aviso', () => {
    const r = interpretarPlanilhaNfe([CAB, linha('10', '6949', 'pix', '')])
    expect(r.ok && r.notas[0].pedido.pagamentos[0].forma).toBe('17')
    expect(r.ok && r.notas[0].avisos[0]).toMatch(/operação sem venda/)
  })

  it('nota mista sem a coluna: sai como venda, com aviso no resumo', () => {
    const r = interpretarPlanilhaNfe([CAB, linha('11', '6910', '', ''), linha('11', '6102', '', '', '2')])
    expect(r.ok && r.notas[0].pedido.pagamentos[0].forma).toBe('17')
    expect(r.ok && r.notas[0].avisos[0]).toMatch(/naturezas diferentes/)
  })
})

describe('API e WhatsApp', () => {
  const base = {
    external_id: 'r-1',
    destinatario: {
      documento: '52998224725', nome: 'Maria',
      endereco: { logradouro: 'Rua A', numero: '10', bairro: 'Centro', codigo_municipio: '3304557', uf: 'RJ', cep: '20040020' },
    },
    itens: [{ codigo: 'P1', descricao: 'Garrafa', ncm: '96170010', cfop: '6949', unidade: 'UN', quantidade: 9, valor_unitario: 40.29, csosn: '400' }],
  }

  it('API sem pagamentos numa remessa: "sem pagamento" (90); natureza_operacao informada vai ao pedido', () => {
    const r = lerPedidoNfe(base)
    expect(r.ok && r.valor.pedido.pagamentos).toEqual([{ forma: '90', valor: 0 }])
    const v = lerPedidoNfe({ ...base, natureza_operacao: 'Remessa por conta e ordem de terceiros' })
    expect(v.ok && v.valor.pedido.naturezaOperacao).toBe('Remessa por conta e ordem de terceiros')
    const venda = lerPedidoNfe({ ...base, itens: [{ ...base.itens[0], cfop: '6102' }] })
    expect(venda.ok && venda.valor.pedido.pagamentos[0].forma).toBe('99')
  })

  it('WhatsApp: a pergunta sugere a natureza do CFOP; o pedido leva a escrita e o pagamento 90', () => {
    expect(perguntaDaNatureza([item('6949')])).toContain('Natureza da operação pelo CFOP 6949: *Simples remessa*, sem pagamento.')
    expect(perguntaDaNatureza([item('5933')])).toContain('O CFOP 5933 não está na minha tabela')
    const destinatario = remessa2232().destinatario
    const pedido = pedidoDoEstado({ passo: 'confirmar', destinatario, itens: [item('6949')], natureza: 'Remessa por conta e ordem de terceiros' })
    expect(pedido.naturezaOperacao).toBe('Remessa por conta e ordem de terceiros')
    expect(pedido.pagamentos).toEqual([{ forma: '90', valor: 0, descricao: null }])
    expect('naturezaOperacao' in pedidoDoEstado({ passo: 'confirmar', destinatario, itens: [item('6949')] })).toBe(false)
  })
})
