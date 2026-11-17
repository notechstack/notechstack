// A documentação do parceiro (agentes/fiscal/dados/api/) acompanha o código: toda rota servida está no openapi.yaml e no
// README, e todo código de erro que as rotas da API devolvem está na tabela de erros.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { NFSE_ROUTES } from '../nfse-routes.js'

const ler = (relativo: string) => readFileSync(fileURLToPath(new URL(relativo, import.meta.url)), 'utf8')
const openapi = ler('../../../../agentes/fiscal/dados/api/openapi.yaml')
const readme = ler('../../../../agentes/fiscal/dados/api/README.md')

describe('documentação da API do parceiro', () => {
  it('cada rota do roteador está no openapi.yaml e no README', () => {
    for (const r of NFSE_ROUTES) {
      const caminho = r.path.replace(/\?.*$/, '').replace(/:(\w+)/g, '{$1}')
      expect(openapi, `${r.method} ${caminho}`).toContain(`  ${caminho}:\n`)
      expect(readme, `${r.method} ${r.path}`).toContain(`${r.method} ${r.path.replace(/\?.*$/, '').replace(/:(\w+)/g, '{$1}')}`)
    }
  })

  it('cada código de erro das rotas públicas está na tabela de erros', () => {
    const fontes = ['../nfse-routes.ts', './empresas.ts'].map(ler).join('\n')
    const codigos = new Set([...fontes.matchAll(/errorResponse\('([A-Z_]+)'/g)].map((m) => m[1]))
    expect(codigos.size).toBeGreaterThan(10)
    for (const c of codigos) {
      expect(readme, c).toContain(`\`${c}\``)
      expect(openapi, c).toContain(c)
    }
  })
})
