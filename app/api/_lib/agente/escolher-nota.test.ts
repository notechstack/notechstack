// A leitura da resposta à lista de notas (etapa `escolher_nota`), sem banco. O caso real de 16/11/2026 está na
// conversa inteira, em emitente.test.ts.
import { describe, expect, it } from 'vitest'
import { ehSairDaEscolha, lerEscolhaDeNota, linhaDaOpcao, listaDeOpcoes, type Candidata } from './escolher-nota.js'

const dia = new Date('2026-11-16T15:00:00Z')
const DA_4_ESTACOES: Candidata = {
  id: 'a', tenantId: 't-4e', numero: '2', nome: 'CONTABILIDADE BRAGANTINA LTDA', valor: '1.00', emitidaEm: dia, empresa: '4 ESTACOES BRAGANCA LTDA',
}
const DO_ESCRITORIO: Candidata = {
  id: 'b', tenantId: 't-cb', numero: '2', nome: 'Soares de Campos Holding Ltda', valor: '1.00', emitidaEm: dia, empresa: 'CONTABILIDADE BRAGANTINA LTDA.',
}
const NUMERO_1: Candidata = {
  id: 'c', tenantId: 't-cb', numero: '1', nome: 'Soares de Campos Holding Ltda', valor: '250.00', emitidaEm: new Date('2026-11-14T15:00:00Z'), empresa: 'CONTABILIDADE BRAGANTINA LTDA.',
}
const LISTA = [DA_4_ESTACOES, DO_ESCRITORIO, NUMERO_1]
const ler = (texto: string, lista: (Candidata | null)[] = LISTA) => lerEscolhaDeNota(lista, texto)

describe('a lista de notas', () => {
  it('numera pela posição e, na conta Escritório, diz a empresa que emitiu antes do cliente', () => {
    expect(linhaDaOpcao(DA_4_ESTACOES, 1)).toBe('1) nº 2 de 4 ESTACOES BRAGANCA LTDA para CONTABILIDADE BRAGANTINA LTDA · R$ 1,00 · 16/11/2026')
    expect(linhaDaOpcao({ ...NUMERO_1, empresa: null }, 3)).toBe('3) nº 1 · Soares de Campos Holding Ltda · R$ 250,00 · 14/11/2026')
    const lista = listaDeOpcoes('Achei mais de uma nota. Qual delas você quer cancelar?', LISTA).split('\n')
    expect(lista).toHaveLength(5)
    expect(lista.at(-1)).toContain('número da opção')
    expect(lista.at(-1)).toContain('*sair*')
  })
})

describe('a resposta à lista', () => {
  it('o número da opção escolhe pela posição, mesmo com duas notas nº 2', () => {
    expect(ler('2')).toEqual({ tipo: 'uma', indice: 1 })
    expect(ler('1')).toEqual({ tipo: 'uma', indice: 0 })
    expect(ler('opção 3')).toEqual({ tipo: 'uma', indice: 2 })
    expect(ler('3)')).toEqual({ tipo: 'uma', indice: 2 })
    expect(ler('a segunda')).toEqual({ tipo: 'uma', indice: 1 })
  })

  it('número fora da lista é o nº da nota (a lista antiga pedia assim)', () => {
    const lista = [{ ...DA_4_ESTACOES, numero: '11' }, { ...DO_ESCRITORIO, numero: '12' }]
    expect(ler('12', lista)).toEqual({ tipo: 'uma', indice: 1 })
    expect(ler('9', lista)).toEqual({ tipo: 'filtro', indices: [], numericas: true })
  })

  it('a linha colada da lista antiga e da nova', () => {
    expect(ler('nº 2 · CONTABILIDADE BRAGANTINA LTDA · R$ 1,00 · 16/11/2026 · 4 ESTACOES BRAGANCA LTDA')).toEqual({ tipo: 'uma', indice: 0 })
    expect(ler('nº 2 · Soares de Campos Holding … · R$ 1,00 · 16/11/2026 · CONTABILIDADE BRAGANTINA LTDA.')).toEqual({ tipo: 'uma', indice: 1 })
    expect(ler(linhaDaOpcao(DO_ESCRITORIO, 2))).toEqual({ tipo: 'uma', indice: 1 })
    expect(ler(linhaDaOpcao(DA_4_ESTACOES, 1))).toEqual({ tipo: 'uma', indice: 0 })
  })

  it('empresa, cliente, valor, nº e data, sozinhos ou juntos', () => {
    expect(ler('4 ESTACOES BRAGANCA LTDA')).toEqual({ tipo: 'uma', indice: 0 })
    expect(ler('a da 4 estações')).toEqual({ tipo: 'uma', indice: 0 })
    expect(ler('250,00')).toEqual({ tipo: 'uma', indice: 2 })
    expect(ler('nº 1')).toEqual({ tipo: 'uma', indice: 2 })
    expect(ler('14/11')).toEqual({ tipo: 'uma', indice: 2 })
    expect(ler('nº 2 Soares')).toEqual({ tipo: 'uma', indice: 1 })
    // Mais de uma bate: volta só com as que restaram.
    expect(ler('N.º 2 - 1,00')).toEqual({ tipo: 'filtro', indices: [0, 1], numericas: true })
    expect(ler('Soares')).toEqual({ tipo: 'filtro', indices: [1, 2], numericas: false })
    expect(ler('contabilidade bragantina')).toEqual({ tipo: 'filtro', indices: [0, 1, 2], numericas: false })
    // Nenhuma bate.
    expect(ler('R$ 99,00')).toEqual({ tipo: 'filtro', indices: [], numericas: true })
  })

  it('nada que sirva de pista vai para a IA (pode ser pedido novo); a nota que saiu da lista não conta', () => {
    expect(ler('Studio Lima')).toEqual({ tipo: 'nada' })
    expect(ler('???')).toEqual({ tipo: 'nada' })
    expect(ler('nº 2', [null, DO_ESCRITORIO, NUMERO_1])).toEqual({ tipo: 'uma', indice: 1 })
    expect(ler('1', [null, DO_ESCRITORIO, NUMERO_1])).toEqual({ tipo: 'uma', indice: 0 })
  })

  it('"sair" e "cancelar pedido" saem da escolha', () => {
    for (const t of ['sair', 'Sair.', 'cancelar pedido', 'nenhuma delas']) expect(ehSairDaEscolha(t)).toBe(true)
    for (const t of ['2', 'sair da 4 estações']) expect(ehSairDaEscolha(t)).toBe(false)
  })
})
