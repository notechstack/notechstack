// Locação na planilha (26/11/2026): colunas opcionais `imovel_*` e `bem_*`, obrigatórias nas linhas com código 99.03.01
// e 99.04.01. Com a flag desligada, a linha de locação volta com o motivo; as demais seguem como antes.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildDps } from '../dps-builder.js'
import type { SefinTenant } from '../sefin.js'
import { errosXsd } from '../../_tests/xsd.js'
import { CAMPOS, interpretarGrade, motivoDoProblema, validarLinhas, type ContextoDoLote, type Empresa } from './lote.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

const IMOBILIARIA: Empresa = {
  id: 'e1',
  cnpj: '12345678000195',
  razao_social: 'Imobiliária Modelo',
  active: true,
  codigo_servico_nacional: '990301',
  codigo_municipio_ibge: '3509502',
  regime: 'presumido',
  // ISS retido no padrão da empresa: não vale na locação.
  retencao: { retem_iss: true, aliquota_iss: '2.00', retem_inss: false, inss_percentual: null },
}
const CPF = '52998224725'
const CNPJ_TOMADOR = '11444777000161'

const contexto = (): ContextoDoLote => ({ empresas: [IMOBILIARIA], bloqueios: new Map([['e1', null]]), modelos: new Map(), jaEmitidas: new Set() })

const CABECALHO = [
  'cpf_cnpj_tomador', 'nome_tomador', 'valor', 'codigo_servico', 'iss_retido', 'imovel_cep', 'imovel_logradouro', 'imovel_numero', 'imovel_bairro',
  'imovel_residencial', 'imovel_cidade', 'imovel_inscricao', 'imovel_copropriedade', 'imovel_valor_total', 'bem_ncm', 'bem_descricao', 'bem_quantidade',
]

function itens(linhas: (string | number | null)[][]) {
  const planilha = interpretarGrade([CABECALHO, ...linhas], { prestadorObrigatorio: false })
  if (!planilha.ok) throw new Error(`planilha recusada: ${JSON.stringify(planilha)}`)
  return validarLinhas(planilha.linhas, contexto())
}

const vazio = (n: number) => Array<string>(n).fill('')

describe('planilha: locação', () => {
  it('as colunas novas são conhecidas e opcionais', () => {
    for (const c of ['imovel_cep', 'imovel_residencial', 'imovel_vencimento', 'imovel_cib', 'bem_ncm', 'bem_descricao', 'bem_quantidade']) {
      expect(CAMPOS).toContain(c)
    }
    // A planilha antiga, sem as colunas de locação, continua valendo.
    expect(interpretarGrade([['cpf_cnpj_tomador', 'nome_tomador', 'valor'], [CPF, 'Maria', '100']], { prestadorObrigatorio: false }).ok).toBe(true)
  })

  it('flag desligada: a linha de locação volta com o motivo', () => {
    vi.stubEnv('NOFISCAL_LOCACAO', '')
    const [i] = itens([[CPF, 'Fulano', '2500,00', '', '', '13015-100', 'Rua das Flores', '120', 'Centro', 'sim', '', '', '', '', '', '', '']])
    expect(i.problema).toBe('LOCACAO_INDISPONIVEL')
    expect(motivoDoProblema('LOCACAO_INDISPONIVEL', {})).toMatch(/assim que a Receita liberar/)
  })

  it('imóvel e bem móvel com a flag ligada: payload com a locação, sem ISS; DPS válida no XSD do release 2', async () => {
    vi.stubEnv('NOFISCAL_LOCACAO', '1')
    const r = itens([
      [CPF, 'Fulano', '2500,00', '', '', '13015-100', 'Rua das Flores', '120', 'Centro', 'sim', '', '123.456', '', '', '', '', ''],
      [CPF, 'Ciclano', '1250,00', '', '', '01310-100', 'Av Paulista', '1000', '', 'comercial', 'São Paulo/SP', '', '50', '2500,00', '', '', ''],
      [CNPJ_TOMADOR, 'Construtora', '3000,00', '99.04.01', '', ...vazio(9), '8474.31.00', 'Betoneira 400 litros', '2'],
    ])
    expect(r.map((i) => i.problema)).toEqual([null, null, null])
    const p = r.map((i) => i.payload as { servico: Record<string, unknown>; retencao?: unknown })
    expect(p[0].servico.locacao).toEqual({
      imovel: {
        municipio_ibge: '3509502', cep: '13015100', logradouro: 'Rua das Flores', numero: '120', bairro: 'Centro', inscricao_imobiliaria: '123.456',
        residencial: true, copropriedade: '100.00', valor_total: '2500.00',
      },
    })
    expect(p[0].retencao).toBeUndefined()
    expect(p[1].servico.locacao).toMatchObject({ imovel: { municipio_ibge: '3550308', residencial: false, copropriedade: '50.00', valor_total: '2500.00' } })
    expect(p[2].servico).toMatchObject({ codigo_servico_nacional: '990401', locacao: { bens: [{ ncm: '84743100', descricao: 'Betoneira 400 litros', quantidade: 2 }] } })

    const tenant: SefinTenant = {
      id: 'e1', cnpj: IMOBILIARIA.cnpj, razao_social: 'X', inscricao_municipal: null, codigo_municipio_ibge: '3509502', regime: 'presumido',
      ambiente: 'producao_restrita', p_tot_trib_sn: null, p_tot_trib: { fed: '13.45', est: '0', mun: '5.00' },
    }
    for (const [n, payload] of p.entries()) {
      const { xml } = buildDps({ tenant, serie: '1', numero: n + 1, payload, now: new Date('2026-12-08T13:00:00Z'), opcoes: { leiaute: 'nt009r2', ibscbs: false, locacao: true } })
      expect(await errosXsd(xml, 'producao-restrita-20261124')).toEqual([])
    }
  })

  it('o que a Sefin recusaria volta com o motivo da linha', () => {
    vi.stubEnv('NOFISCAL_LOCACAO', '1')
    const r = itens([
      // Sem CEP nem residencial.
      [CPF, 'Fulano', '2500,00', '', '', '', 'Rua das Flores', '120', '', '', '', '', '', '', '', '', ''],
      // ISS retido pedido na locação.
      [CPF, 'Fulano', '2500,00', '', 'sim', '13015-100', 'Rua das Flores', '120', '', 'sim', '', '', '', '', '', '', ''],
      // Copropriedade de 50% sem bater com o valor total (E0433).
      [CPF, 'Fulano', '2500,00', '', '', '13015-100', 'Rua das Flores', '120', '', 'sim', '', '', '50', '4000,00', '', '', ''],
      // Bem sem NCM.
      [CNPJ_TOMADOR, 'Construtora', '3000,00', '99.04.01', '', ...vazio(9), '', 'Betoneira', '1'],
      // Cidade do imóvel que não existe.
      [CPF, 'Fulano', '2500,00', '', '', '13015-100', 'Rua das Flores', '120', '', 'sim', 'Cidade Nenhuma/XX', '', '', '', '', '', ''],
    ])
    expect(r.map((i) => i.problema)).toEqual(['LOCACAO_SEM_DADOS', 'LOCACAO_COM_ISS', 'LOCACAO_INVALIDA', 'LOCACAO_SEM_DADOS', 'LOCACAO_INVALIDA'])
    expect(motivoDoProblema('LOCACAO_SEM_DADOS', {})).toMatch(/imovel_cep/)
    expect(motivoDoProblema('LOCACAO_COM_ISS', {})).toMatch(/não tem ISS/)
  })

  it('linha de outro código ignora as colunas de locação', () => {
    vi.stubEnv('NOFISCAL_LOCACAO', '')
    const [i] = itens([[CPF, 'Maria', '100,00', '04.01.01', 'não', '13015-100', 'Rua', '1', '', 'sim', '', '', '', '', '8474.31.00', 'Betoneira', '1']])
    expect(i.problema).toBe(null)
    expect((i.payload as { servico: Record<string, unknown> }).servico.locacao).toBeUndefined()
  })
})
