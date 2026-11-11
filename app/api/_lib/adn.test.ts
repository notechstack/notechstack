// Conferência da procuração no ADN (Manual dos Contribuintes das APIs do ADN v1.1, 03/11/2026): a URL leva
// `cnpjConsulta`, a conexão usa o certificado do procurador, e a resposta vira procuracao_ok, sem_procuracao ou
// indisponivel. Transporte em dublê: nenhuma chamada ao ADN.
import { describe, expect, it } from 'vitest'
import { makeTestCertificate } from '../_tests/certs.js'
import { codigosDoAdn, createAdnClient } from './adn.js'
import type { HttpRequest, HttpResponse, TlsCredentials } from './sefin-client.js'

const cert = makeTestCertificate()

function cliente(resposta: HttpResponse | Error) {
  const pedidos: { request: HttpRequest; tls: TlsCredentials }[] = []
  const adn = createAdnClient({
    transport: async (request, tls) => {
      pedidos.push({ request, tls })
      if (resposta instanceof Error) throw resposta
      return resposta
    },
  })
  return { adn, pedidos }
}

const conferir = (resposta: HttpResponse | Error) => {
  const c = cliente(resposta)
  return c.adn.conferirProcuracao!({ cnpjConsulta: '56210013000140', ambiente: 'producao', certificado: cert.certificado }).then((r) => ({
    r,
    pedidos: c.pedidos,
  }))
}

describe('conferência da procuração no ADN', () => {
  it('consulta como procurador, com cnpjConsulta do outorgante, e 200 é procuração ok', async () => {
    const { r, pedidos } = await conferir({ status: 200, body: JSON.stringify({ TipoConsulta: 'Procuracao', LoteDFe: [] }) })
    expect(r).toEqual({ kind: 'procuracao_ok' })
    expect(pedidos).toHaveLength(1)
    expect(pedidos[0].request.url).toBe('https://adn.nfse.gov.br/contribuintes/DFe/0?lote=true&cnpjConsulta=56210013000140')
    expect(pedidos[0].request.method).toBe('GET')
    expect(pedidos[0].tls.cert).toContain('BEGIN CERTIFICATE')
  })

  it('404 sem documentos (E2220) também prova a procuração', async () => {
    const { r } = await conferir({ status: 404, body: JSON.stringify({ Erros: [{ Codigo: 'E2220', Descricao: 'Nenhum documento localizado' }] }) })
    expect(r).toEqual({ kind: 'procuracao_ok' })
    expect((await conferir({ status: 404, body: '' })).r).toEqual({ kind: 'procuracao_ok' })
  })

  it('E2245 é falta de procuração; E2243 também', async () => {
    const corpo = JSON.stringify({ erros: [{ codigo: 'E2245', descricao: 'Não há procuração da inscrição 56210013000140 para a inscrição 60342339000106.' }] })
    expect((await conferir({ status: 400, body: corpo })).r).toEqual({ kind: 'sem_procuracao', codigo: 'E2245' })
    const raiz = JSON.stringify({ erros: [{ codigo: 'E2243', descricao: 'O CNPJ informado na consulta deve ter o mesmo CNPJ base' }] })
    expect((await conferir({ status: 400, body: raiz })).r).toEqual({ kind: 'sem_procuracao', codigo: 'E2243' })
  })

  it('certificado de transmissão, 5xx, outro 404 e rede caída ficam indisponíveis', async () => {
    expect((await conferir({ status: 400, body: JSON.stringify({ erros: [{ codigo: 'E2213' }] }) })).r).toEqual({ kind: 'indisponivel', motivo: 'E2213' })
    expect((await conferir({ status: 503, body: '' })).r).toEqual({ kind: 'indisponivel', motivo: 'HTTP_503' })
    expect((await conferir({ status: 404, body: JSON.stringify({ erros: [{ codigo: 'E2241' }] }) })).r).toEqual({ kind: 'indisponivel', motivo: 'E2241' })
    expect((await conferir(new Error('ECONNRESET'))).r).toEqual({ kind: 'indisponivel', motivo: 'TRANSPORTE_DESCONHECIDO' })
  })

  it('certificado que não abre não chega à rede', async () => {
    const c = cliente({ status: 200, body: '{}' })
    const r = await c.adn.conferirProcuracao!({ cnpjConsulta: '56210013000140', ambiente: 'producao', certificado: { pfxBase64: 'eA==', password: 'x' } })
    expect(r).toEqual({ kind: 'indisponivel', motivo: 'CERT_INVALID' })
    expect(c.pedidos).toHaveLength(0)
  })

  it('baixarNfse com cnpjConsulta leva o parâmetro em cada página', async () => {
    const c = cliente({ status: 404, body: '' })
    await c.adn.baixarNfse({ cnpj: '56210013000140', ambiente: 'producao_restrita', certificado: cert.certificado, cnpjConsulta: '56210013000140' })
    expect(c.pedidos[0].request.url).toBe('https://adn.producaorestrita.nfse.gov.br/contribuintes/DFe/0?lote=true&cnpjConsulta=56210013000140')
  })

  it('lê os códigos com qualquer caixa', () => {
    expect(codigosDoAdn('{"Erros":[{"Codigo":"E2245"},{"codigo":"e2220"}]}')).toEqual(['E2245', 'E2220'])
  })
})
