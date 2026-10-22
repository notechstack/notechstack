import { describe, expect, it } from 'vitest'
import { catalogoDoSite } from './catalogo-servicos.js'

describe('catálogo de serviços do site', () => {
  it('devolve a descrição sem o ponto final da lista oficial', async () => {
    const lista = { itens: [{ codigo: '040101', descricao: ' Medicina. ' }, { codigo: '010701', descricao: 'Suporte técnico em informática' }] }
    const catalogo = catalogoDoSite({
      site: 'https://site.test/agentes/fiscal/',
      fetch: (async () => new Response(JSON.stringify(lista), { status: 200 })) as typeof fetch,
    })
    expect(await catalogo.descricao('040101')).toBe('Medicina')
    expect(await catalogo.descricao('010701')).toBe('Suporte técnico em informática')
    expect(await catalogo.descricao('999999')).toBeNull()
  })
})
