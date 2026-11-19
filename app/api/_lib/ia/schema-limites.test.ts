// Limites da saída estruturada da Anthropic (docs "Structured outputs", tabela de limites): no
// máximo 16 parâmetros com união (`anyOf` ou `type` em lista) no schema inteiro. Passou disso, a
// API devolve 400 na hora, o SDK não tenta de novo e toda mensagem nova vira "Não consegui
// entender agora" (19/11/2026: o grupo obra levou o schema do pedido a 22 uniões).
import { describe, expect, it } from 'vitest'
import { SCHEMA_PARSED } from '../agente/interprete-claude.js'
import { SCHEMA_DANFSE } from './leitor-pdf.js'

const MAX_UNIOES = 16

function contarUnioes(no: unknown): number {
  if (Array.isArray(no)) return no.reduce((soma: number, item) => soma + contarUnioes(item), 0)
  if (typeof no !== 'object' || no === null) return 0
  const o = no as Record<string, unknown>
  const aqui = Array.isArray(o.anyOf) || Array.isArray(o.type) ? 1 : 0
  return aqui + Object.values(o).reduce((soma: number, valor) => soma + contarUnioes(valor), 0)
}

describe('schemas da IA cabem nos limites da saída estruturada', () => {
  it.each([
    ['pedido (SCHEMA_PARSED)', SCHEMA_PARSED],
    ['leitor de PDF (SCHEMA_DANFSE)', SCHEMA_DANFSE],
  ])('%s tem no máximo 16 uniões', (_nome, schema) => {
    expect(contarUnioes(schema)).toBeLessThanOrEqual(MAX_UNIOES)
  })

  it('conta uniões aninhadas', () => {
    const s = { anyOf: [{ type: 'object', properties: { a: { anyOf: [{ type: 'string' }, { type: 'null' }] }, b: { type: ['string', 'null'] } } }, { type: 'null' }] }
    expect(contarUnioes(s)).toBe(3)
  })
})
