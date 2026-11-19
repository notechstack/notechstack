// A consulta de CNPJ do lado Vercel é cópia da edge function: o corpo tem de ser igual, linha a linha.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ler = (relativo: string) => readFileSync(fileURLToPath(new URL(relativo, import.meta.url)), 'utf8')

describe('receita.ts', () => {
  it('é a mesma consulta de supabase/functions/_shared/fiscal/cnpj.ts', () => {
    const copia = ler('./receita.ts').split('\n').filter((l) => !l.startsWith('// Cópia') && !l.startsWith('// não enxerga') && !l.startsWith('// regra de CNPJ'))
    const original = ler('../../../../supabase/functions/_shared/fiscal/cnpj.ts').split('\n')
    expect(copia.join('\n')).toBe(original.join('\n'))
  })
})
