import { describe, expect, it } from 'vitest'
import { consultaCnpjBrasilApi, USER_AGENT } from './consulta-cnpj.js'

// A BrasilAPI responde 403 ao user-agent padrão do Node ("node"), que é o do app na Vercel (22/10/2026).
describe('consulta de CNPJ do tomador', () => {
  it('vai com user-agent próprio e devolve a razão social', async () => {
    let headers: Record<string, string> = {}
    const consulta = consultaCnpjBrasilApi({
      fetch: (async (_url: string, init?: RequestInit) => {
        headers = init?.headers as Record<string, string>
        return new Response(JSON.stringify({ razao_social: 'EMPRESA X LTDA' }), { status: 200 })
      }) as typeof fetch,
    })
    expect(await consulta.razaoSocial('11.222.333/0001-81')).toBe('EMPRESA X LTDA')
    expect(headers['user-agent']).toBe(USER_AGENT)
  })
})
