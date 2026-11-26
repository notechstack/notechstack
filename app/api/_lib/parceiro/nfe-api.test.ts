// Corpo do POST /v1/nfe: transportador e volumes (23/11/2026) viram os campos do PedidoNfe; sem eles, nada muda.
import { describe, expect, it } from 'vitest'
import { lerPedidoNfe } from './nfe-api.js'

const base = {
  external_id: 'nfe-1',
  destinatario: {
    documento: '52998224725',
    nome: 'Maria',
    endereco: { logradouro: 'Rua A', numero: '10', bairro: 'Centro', codigo_municipio: '3550308', uf: 'SP', cep: '01001000' },
  },
  itens: [{ codigo: 'P1', descricao: 'Produto', ncm: '61091000', cfop: '5102', unidade: 'UN', quantidade: 1, valor_unitario: 50, csosn: '102' }],
}

describe('POST /v1/nfe: transporte', () => {
  it('sem transportador nem volumes, o pedido não ganha as chaves', () => {
    const r = lerPedidoNfe(base)
    expect(r.ok && Object.keys(r.valor.pedido)).not.toContain('transportador')
    expect(r.ok && Object.keys(r.valor.pedido)).not.toContain('volumes')
  })

  it('transportador e volumes', () => {
    const r = lerPedidoNfe({
      ...base,
      modalidade_frete: '1',
      transportador: { documento: '11444777000161', nome: 'Transp', inscricao_estadual: 'ISENTO', uf: 'mg' },
      volumes: [{ quantidade: 10, especie: 'CAIXA', peso_liquido: 60.4, peso_bruto: 60.4 }],
    })
    expect(r.ok && r.valor.pedido).toMatchObject({
      modalidadeFrete: '1',
      transportador: { documento: '11444777000161', nome: 'Transp', inscricaoEstadual: 'ISENTO', uf: 'MG' },
      volumes: [{ quantidade: 10, especie: 'CAIXA', pesoLiquido: 60.4, pesoBruto: 60.4 }],
    })
  })

  it('campo desconhecido e tipo errado são recusados', () => {
    expect(lerPedidoNfe({ ...base, transportador: { placa: 'ABC1234' } })).toMatchObject({ ok: false, codigo: 'UNKNOWN_FIELD', mensagem: 'campo não aceito: transportador.placa' })
    expect(lerPedidoNfe({ ...base, volumes: { quantidade: 1 } })).toMatchObject({ ok: false, mensagem: 'volumes deve ser uma lista' })
    expect(lerPedidoNfe({ ...base, volumes: [{ peso_bruto: '1,5' }] })).toMatchObject({ ok: false, mensagem: expect.stringContaining('volumes[0].peso_bruto') })
  })
})
