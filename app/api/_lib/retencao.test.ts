import { describe, expect, it } from 'vitest'
import {
  enderecoDaReceita,
  inssDoPercentual,
  issRetido,
  lerAliquotaIss,
  lerPercentualInss,
  lerSimNao,
  lerValorEmReais,
  linhasDaRetencao,
  padraoDaLinha,
  resolverRetencao,
  SEM_RETENCAO_PADRAO,
  valorLiquido,
  type RetencaoPadrao,
} from './retencao.js'

const padrao = (p: Partial<RetencaoPadrao> = {}): RetencaoPadrao => ({ ...SEM_RETENCAO_PADRAO, ...p })
const resolver = (d: Partial<Parameters<typeof resolverRetencao>[0]>) =>
  resolverRetencao({ padrao: padrao(), valor: '1500.00', regime: 'simples', tomadorTipo: 'cnpj', ...d })

describe('retenção: leitura dos números', () => {
  it('alíquota do ISS de 2% a 5%, no formato do leiaute', () => {
    expect(['2', '2,5', '2.50', '5%', ' 3 % ', 4].map(lerAliquotaIss)).toEqual(['2.00', '2.50', '2.50', '5.00', '3.00', '4.00'])
    expect(['1,8', '5,01', '10', 'dois', '', '2,555'].map(lerAliquotaIss)).toEqual([null, null, null, null, null, null])
  })

  it('percentual do INSS entre 0 e 100', () => {
    expect(['11', '11%', '3,5'].map(lerPercentualInss)).toEqual(['11.00', '11.00', '3.50'])
    expect(['0', '100', 'x'].map(lerPercentualInss)).toEqual([null, null, null])
  })

  it('valor em reais', () => {
    expect(['165,00', '1.234,56', 'R$ 38.5', '38', 12.3].map(lerValorEmReais)).toEqual(['165.00', '1234.56', '38.50', '38.00', '12.30'])
    expect(['0', '1,234', 'abc', -3].map(lerValorEmReais)).toEqual([null, null, null, null])
  })

  it('contas ao centavo, meio para cima', () => {
    expect(inssDoPercentual('1500.00', '11.00')).toBe('165.00')
    expect(inssDoPercentual('333.33', '11.00')).toBe('36.67')
    expect(issRetido('1500.00', '2.50')).toBe('37.50')
    expect(valorLiquido('1500.00', { iss: { aliquota: '2.50' }, inss: { valor: '165.00' } })).toBe('1297.50')
  })

  it('sim/não da planilha', () => {
    expect(['sim', 'S', 'x', 'Não', 'nao', 'n', '', undefined, '2%'].map(lerSimNao)).toEqual([true, true, true, false, false, false, undefined, undefined, null])
  })
})

describe('retenção: o pedido manda, o resto vem da empresa', () => {
  it('sem padrão e sem pedido: sem retenção', () => {
    expect(resolver({})).toEqual({ ok: true, retencao: null })
  })

  it('padrão da empresa vira a retenção da nota (INSS pelo percentual)', () => {
    const r = resolver({ padrao: padrao({ retem_iss: true, aliquota_iss: '2.00', retem_inss: true, inss_percentual: '11.00' }) })
    expect(r).toEqual({ ok: true, retencao: { iss: { aliquota: '2.00' }, inss: { valor: '165.00' } } })
  })

  it('"sem retenção" no pedido desliga o padrão; alíquota ou INSS escritos ligam', () => {
    const empresa = padrao({ retem_iss: true, aliquota_iss: '2.00', retem_inss: true, inss_percentual: '11.00' })
    expect(resolver({ padrao: empresa, pedido: { iss: false, inss: false } })).toEqual({ ok: true, retencao: null })
    expect(resolver({ pedido: { aliquotaIss: '3' } })).toEqual({ ok: true, retencao: { iss: { aliquota: '3.00' } } })
    expect(resolver({ pedido: { inssTexto: '11%' } })).toEqual({ ok: true, retencao: { inss: { valor: '165.00' } } })
    expect(resolver({ pedido: { inssTexto: '150,00' } })).toEqual({ ok: true, retencao: { inss: { valor: '150.00' } } })
    expect(resolver({ padrao: empresa, pedido: { aliquotaIss: '5' } })).toEqual({ ok: true, retencao: { iss: { aliquota: '5.00' }, inss: { valor: '165.00' } } })
  })

  it('o que a Sefin recusaria vira problema antes', () => {
    expect(resolver({ regime: 'mei', pedido: { iss: true, aliquotaIss: '2' } })).toEqual({ ok: false, problema: 'RETENCAO_MEI' })
    expect(resolver({ regime: 'mei', pedido: { inssTexto: '11%' } })).toEqual({ ok: false, problema: 'RETENCAO_MEI' })
    expect(resolver({ tomadorTipo: 'cpf', pedido: { aliquotaIss: '2' } })).toEqual({ ok: false, problema: 'ISS_RETIDO_CPF' })
    expect(resolver({ pedido: { iss: true } })).toEqual({ ok: false, problema: 'ALIQUOTA_ISS_FALTANDO' })
    expect(resolver({ pedido: { aliquotaIss: '7' } })).toEqual({ ok: false, problema: 'ALIQUOTA_ISS_INVALIDA' })
    expect(resolver({ pedido: { inss: true } })).toEqual({ ok: false, problema: 'INSS_FALTANDO' })
    expect(resolver({ pedido: { inssTexto: '1500,00' } })).toEqual({ ok: false, problema: 'INSS_INVALIDO' })
    expect(resolver({ pedido: { inssTexto: 'muito' } })).toEqual({ ok: false, problema: 'INSS_INVALIDO' })
    expect(resolver({ pedido: { aliquotaIss: '5', inssTexto: '1450,00' } })).toEqual({ ok: false, problema: 'RETENCOES_ACIMA_DO_VALOR' })
  })

  it('INSS retido de tomador CPF passa (só o ISS exige CNPJ)', () => {
    expect(resolver({ tomadorTipo: 'cpf', pedido: { inssTexto: '11%' } })).toEqual({ ok: true, retencao: { inss: { valor: '165.00' } } })
  })

  it('tomador CPF não herda a retenção padrão da empresa (Bragantina, 26/11/2026)', () => {
    const soIss = padrao({ retem_iss: true, aliquota_iss: '2.01' })
    const issEInss = padrao({ retem_iss: true, aliquota_iss: '3.06', retem_inss: true, inss_percentual: '11.00' })
    expect(resolver({ tomadorTipo: 'cpf', padrao: soIss })).toEqual({ ok: true, retencao: null })
    expect(resolver({ tomadorTipo: 'cpf', padrao: issEInss })).toEqual({ ok: true, retencao: null })
    // Com CNPJ, o padrão continua valendo.
    expect(resolver({ tomadorTipo: 'cnpj', padrao: soIss })).toEqual({ ok: true, retencao: { iss: { aliquota: '2.01' } } })
    // O pedido explícito ainda manda: ISS retido de CPF é recusado; "INSS retido" usa o percentual da empresa.
    expect(resolver({ tomadorTipo: 'cpf', padrao: soIss, pedido: { iss: true } })).toEqual({ ok: false, problema: 'ISS_RETIDO_CPF' })
    expect(resolver({ tomadorTipo: 'cpf', padrao: issEInss, pedido: { inss: true } })).toEqual({ ok: true, retencao: { inss: { valor: '165.00' } } })
  })

  it('linhas do resumo', () => {
    expect(linhasDaRetencao('1500.00', { iss: { aliquota: '2.50' }, inss: { valor: '165.00' } })).toEqual([
      'ISS retido pelo tomador: 2,5% (R$ 37,50)',
      'INSS retido: R$ 165,00',
      'Valor líquido: R$ 1.297,50',
    ])
    expect(linhasDaRetencao('1500.00', null)).toEqual([])
  })

  it('padrão lido do banco (numeric chega como texto)', () => {
    expect(padraoDaLinha({ retem_iss: true, aliquota_iss: '2.5', retem_inss: false, inss_percentual: null })).toEqual({
      retem_iss: true,
      aliquota_iss: '2.50',
      retem_inss: false,
      inss_percentual: null,
    })
  })
})

describe('endereço do tomador pela Receita (BrasilAPI)', () => {
  const corpo = {
    cep: '1310100',
    codigo_municipio_ibge: 3550308,
    descricao_tipo_de_logradouro: 'AVENIDA',
    logradouro: 'PAULISTA',
    numero: '1000',
    complemento: '',
    bairro: 'BELA VISTA',
  }
  it('monta o endNac (CEP com zero à esquerda, tipo do logradouro, S/N sem número)', () => {
    expect(enderecoDaReceita(corpo)).toEqual({ cMun: '3550308', cep: '01310100', logradouro: 'AVENIDA PAULISTA', numero: '1000', complemento: null, bairro: 'BELA VISTA' })
    expect(enderecoDaReceita({ ...corpo, numero: '', logradouro: 'AVENIDA PAULISTA' })?.numero).toBe('S/N')
    expect(enderecoDaReceita({ ...corpo, logradouro: 'AVENIDA PAULISTA' })?.logradouro).toBe('AVENIDA PAULISTA')
  })
  it('sem município, CEP, logradouro ou bairro: null', () => {
    expect(enderecoDaReceita({ ...corpo, codigo_municipio_ibge: null })).toBeNull()
    expect(enderecoDaReceita({ ...corpo, bairro: '' })).toBeNull()
    expect(enderecoDaReceita(null)).toBeNull()
  })
})

describe('retenção federal do Lucro Presumido e Real (19/11/2026)', () => {
  it('IRRF e PIS/COFINS/CSLL por percentual ou valor; líquido desconta tudo', () => {
    const r = resolver({ regime: 'presumido', valor: '1000.00', pedido: { irrfTexto: '1,5%', csrfTexto: '46,50', inss: true, inssTexto: '11%' } })
    expect(r).toEqual({ ok: true, retencao: { inss: { valor: '110.00' }, irrf: { valor: '15.00' }, csrf: { valor: '46.50' } } })
    if (!r.ok || !r.retencao) throw new Error('esperava retenção')
    expect(valorLiquido('1000.00', r.retencao)).toBe('828.50')
    expect(linhasDaRetencao('1000.00', r.retencao)).toEqual([
      'INSS retido: R$ 110,00',
      'IRRF retido: R$ 15,00',
      'PIS/COFINS/CSLL retidos: R$ 46,50',
      'Valor líquido: R$ 828,50',
    ])
  })

  it('Simples e MEI recusam; valores inválidos também', () => {
    expect(resolver({ regime: 'simples', pedido: { irrfTexto: '1,5%' } })).toEqual({ ok: false, problema: 'RETENCAO_FEDERAL_SO_LUCRO' })
    expect(resolver({ regime: 'mei', pedido: { csrfTexto: '4,65%' } })).toEqual({ ok: false, problema: 'RETENCAO_MEI' })
    expect(resolver({ regime: 'real', pedido: { irrfTexto: 'x' } })).toEqual({ ok: false, problema: 'IRRF_INVALIDO' })
    expect(resolver({ regime: 'real', pedido: { csrfTexto: '1500,00' } })).toEqual({ ok: false, problema: 'CSRF_INVALIDO' })
  })
})
