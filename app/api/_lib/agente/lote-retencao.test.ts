// Retenção na planilha (Lucca, 16/11/2026): colunas opcionais `iss_retido` e `inss_retido`; vazias, vale o padrão da
// empresa. A planilha de 6 colunas continua valendo (o teste do modelo publicado, em lote.test.ts, cobre isso).
import { describe, expect, it } from 'vitest'
import type { EnderecoNacional } from '../retencao.js'
import { completarEnderecos, interpretarGrade, lerRetencaoDaLinha, textoDasRetencoes, validarLinhas, type ContextoDoLote, type Empresa } from './lote.js'

const SIMPLES: Empresa = {
  id: 'e1',
  cnpj: '12345678000195',
  razao_social: 'Oficina Trilho',
  active: true,
  codigo_servico_nacional: '071001', // 07.10.01: sem obra (E0370 vale para 07.02.01, testado em obra.test.ts)
  regime: 'simples',
  retencao: { retem_iss: false, aliquota_iss: null, retem_inss: true, inss_percentual: '11.00' },
}
const MEI: Empresa = { id: 'e2', cnpj: '11222333000181', razao_social: 'Pintor MEI', active: true, codigo_servico_nacional: '071001', regime: 'mei' }
const CNPJ_TOMADOR = '11444777000161'
const CPF = '52998224725'
const ENDERECO: EnderecoNacional = { cMun: '3550308', cep: '01310100', logradouro: 'AVENIDA PAULISTA', numero: '1000', complemento: null, bairro: 'BELA VISTA' }

const contexto = (): ContextoDoLote => ({
  empresas: [SIMPLES, MEI],
  bloqueios: new Map([
    ['e1', null],
    ['e2', null],
  ]),
  modelos: new Map(),
  jaEmitidas: new Set(),
})

function itens(linhas: (string | number | null)[][]) {
  const planilha = interpretarGrade(
    [['cnpj_prestador', 'cpf_cnpj_tomador', 'nome_tomador', 'valor', 'iss_retido', 'inss_retido'], ...linhas],
    { prestadorObrigatorio: true },
  )
  if (!planilha.ok) throw new Error('planilha recusada')
  return validarLinhas(planilha.linhas, contexto())
}

describe('planilha: colunas de retenção', () => {
  it('lê sim/não, alíquota, percentual, valor e o percentual formatado do Excel', () => {
    expect(lerRetencaoDaLinha({ iss_retido: 'sim', inss_retido: 'não' })).toEqual({ iss: true, inss: false })
    expect(lerRetencaoDaLinha({ iss_retido: '2,5%', inss_retido: '11%' })).toEqual({ iss: true, aliquotaIss: '2,5%', inss: true, inssTexto: '11%' })
    expect(lerRetencaoDaLinha({ iss_retido: 0.02, inss_retido: 0.11 })).toEqual({ iss: true, aliquotaIss: '2', inss: true, inssTexto: '11%' })
    expect(lerRetencaoDaLinha({ inss_retido: '165,00' })).toEqual({ inss: true, inssTexto: '165,00' })
    expect(lerRetencaoDaLinha({ iss_retido: '', inss_retido: null })).toEqual({})
    expect(lerRetencaoDaLinha({ iss_retido: 'talvez' })).toBe('ISS_RETIDO_INVALIDO')
  })

  it('vazia = padrão da empresa; a linha pode ligar ou desligar', () => {
    const r = itens([
      [SIMPLES.cnpj, CNPJ_TOMADOR, 'Clínica', '1500,00', '', ''],
      [SIMPLES.cnpj, CNPJ_TOMADOR, 'Clínica', '1000,00', '2%', 'não'],
      [SIMPLES.cnpj, CPF, 'Maria', '200,00', '', '20,00'],
    ])
    expect(r.map((i) => i.problema)).toEqual([null, null, null])
    expect(r.map((i) => i.payload.retencao)).toEqual([
      { inss: { valor: '165.00' } },
      { iss: { aliquota: '2.00' } },
      { inss: { valor: '20.00' } },
    ])
    expect(textoDasRetencoes(r)).toBe('Com retenção: 1 nota com ISS retido, 2 notas com INSS retido.')
  })

  it('o que a Sefin recusaria fica de fora com o motivo da linha', () => {
    const r = itens([
      [MEI.cnpj, CNPJ_TOMADOR, 'Clínica', '500,00', 'sim', ''],
      [SIMPLES.cnpj, CPF, 'Maria', '500,00', '2%', ''],
      [SIMPLES.cnpj, CNPJ_TOMADOR, 'Clínica', '500,00', 'sim', ''],
      [SIMPLES.cnpj, CNPJ_TOMADOR, 'Clínica', '500,00', 'talvez', ''],
      [SIMPLES.cnpj, CNPJ_TOMADOR, 'Clínica', '500,00', '', '600,00'],
      [MEI.cnpj, CNPJ_TOMADOR, 'Clínica', '500,00', '', ''],
    ])
    expect(r.map((i) => i.problema)).toEqual(['RETENCAO_MEI', 'ISS_RETIDO_CPF', 'ALIQUOTA_ISS_FALTANDO', 'ISS_RETIDO_INVALIDO', 'INSS_INVALIDO', null])
    expect(r[5].payload.retencao).toBeUndefined()
  })

  it('ISS retido busca o endereço do tomador uma vez por CNPJ; sem endereço, a linha sai com ENDERECO_TOMADOR', async () => {
    const r = itens([
      [SIMPLES.cnpj, CNPJ_TOMADOR, 'Clínica', '1000,00', '2%', 'não'],
      [SIMPLES.cnpj, CNPJ_TOMADOR, 'Clínica', '1200,00', '3%', 'não'],
      [SIMPLES.cnpj, '11222333000181', 'Outra', '900,00', '2%', 'não'],
      [SIMPLES.cnpj, CPF, 'Maria', '200,00', '', 'não'],
    ])
    const pedidos: string[] = []
    await completarEnderecos(r, {
      async endereco(cnpj) {
        pedidos.push(cnpj)
        return cnpj === CNPJ_TOMADOR ? ENDERECO : null
      },
    })
    expect(pedidos).toEqual([CNPJ_TOMADOR, '11222333000181'])
    expect(r.map((i) => i.problema)).toEqual([null, null, 'ENDERECO_TOMADOR', null])
    expect((r[0].payload.tomador as { endereco?: EnderecoNacional }).endereco).toEqual(ENDERECO)
    expect((r[3].payload.tomador as { endereco?: EnderecoNacional }).endereco).toBeUndefined()
  })
})
