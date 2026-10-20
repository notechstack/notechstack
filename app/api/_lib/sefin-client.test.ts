// Cliente real da Sefin (Landing, lote 2b - cliente Sefin real), sem rede: o transporte é um
// dublê que responde no formato do OpenAPI, ou um servidor HTTPS local com mTLS.
// Checks: C40 (URL por ambiente); mapeamento de respostas e mTLS como testes extras.
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import type { TLSSocket } from 'node:tls'
import { afterAll, describe, expect, it } from 'vitest'
import { makeTestCertificate, sharedTestCertificate } from '../_tests/certs.js'
import { fakeSefin } from '../_tests/sefin-fake.js'
import { verifySignature } from '../_tests/verify-signature.js'
import type { SefinInvoice, SefinTenant } from './sefin.js'
import { createSefinClient, gunzipBase64, gzipBase64, httpsTransport, SEFIN_BASE_URLS, type SefinTransport } from './sefin-client.js'

const tenant = (overrides: Partial<SefinTenant> = {}): SefinTenant => ({
  id: 't-1',
  cnpj: '56210013000140',
  razao_social: 'PRIMECARE',
  inscricao_municipal: null,
  codigo_municipio_ibge: '3550308',
  regime: 'simples',
  ambiente: 'producao_restrita',
  p_tot_trib_sn: '6.00',
  ...overrides,
})

const payload = {
  tomador: { cpf: '12345678909', nome: 'Maria da Silva' },
  servico: { codigo_servico_nacional: '040101', descricao: 'Consulta' },
  valor: '42.90',
}

function invoiceFor(client: ReturnType<typeof createSefinClient>, t: SefinTenant, numero = 1): SefinInvoice {
  return { id: 'inv-1', external_id: 'venda-1', payload, dps_serie: '1', dps_numero: numero, id_dps: client.idDps({ tenant: t, serie: '1', numero }) }
}

const CHAVE = '35503082256210013000140000000000001261100000000010'

describe('URL por ambiente (C40)', () => {
  it('URL por ambiente', async () => {
    const cert = sharedTestCertificate()
    for (const [ambiente, base, tpAmb] of [
      ['producao_restrita', 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional', '2'],
      ['producao', 'https://sefin.nfse.gov.br/SefinNacional', '1'],
    ] as const) {
      const fake = fakeSefin()
      const client = createSefinClient({ transport: fake.transport })
      const t = tenant({ ambiente })
      const invoice = invoiceFor(client, t)

      await client.emitir({ tenant: t, invoice, certificado: cert.certificado })
      await client.consultarPorIdDps({ tenant: t, idDps: invoice.id_dps, certificado: cert.certificado })
      await client.cancelar({ tenant: t, chaveAcesso: CHAVE, certificado: cert.certificado })
      await client.consultarCancelamento({ tenant: t, chaveAcesso: CHAVE, certificado: cert.certificado })

      expect(SEFIN_BASE_URLS[ambiente]).toBe(base)
      expect(fake.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        `POST ${base}/nfse`,
        `GET ${base}/dps/${invoice.id_dps}`,
        `GET ${base}/nfse/${fake.issued.get(invoice.id_dps)!.chave}`,
        `POST ${base}/nfse/${CHAVE}/eventos`,
        `GET ${base}/nfse/${CHAVE}/eventos/101101/1`,
      ])
      // O ambiente também vai no XML (tpAmb 2 = produção restrita, 1 = produção).
      expect(fake.requests[0].xml).toContain(`<tpAmb>${tpAmb}</tpAmb>`)
      expect(fake.requests[3].xml).toContain(`<tpAmb>${tpAmb}</tpAmb>`)
    }
  })
})

describe('emissão pelo cliente real', () => {
  it('envia a DPS assinada em dpsXmlGZipB64 e devolve authorized com a NFS-e', async () => {
    const cert = sharedTestCertificate()
    const fake = fakeSefin()
    const client = createSefinClient({ transport: fake.transport })
    const t = tenant()
    const invoice = invoiceFor(client, t, 42)

    const result = await client.emitir({ tenant: t, invoice, certificado: cert.certificado })

    expect(result.kind).toBe('authorized')
    if (result.kind !== 'authorized') return
    const request = fake.requests[0]
    expect(Object.keys(JSON.parse(request.body!))).toEqual(['dpsXmlGZipB64'])
    expect(request.headers['content-type']).toMatch(/application\/json/)
    // O XML transmitido é exatamente o guardado em xml_dps, e a assinatura verifica.
    expect(request.xml).toBe(result.xmlDps)
    expect(verifySignature(result.xmlDps, cert.certPem)).toBe(true)
    expect(result.chaveAcesso).toBe(fake.issued.get(invoice.id_dps)!.chave)
    expect(result.xmlNfse).toContain(`<infNFSe Id="NFS${result.chaveAcesso}">`)
    // mTLS com o PEM do próprio A1 (nunca o PFX ou a senha no transporte).
    expect(request.tls.key).toMatch(/BEGIN RSA PRIVATE KEY/)
    expect(request.tls.cert).toContain(cert.certPem.replace(/\r/g, '').split('\n')[1])
    expect(JSON.stringify(request)).not.toContain(cert.certificado.password)
    expect(JSON.stringify(request)).not.toContain(cert.certificado.pfxBase64.slice(0, 60))
  })

  it('400 com erros vira rejected com o código da Sefin, sem diferenciar maiúsculas', async () => {
    const fake = fakeSefin({
      emitir: () => ({
        status: 400,
        body: JSON.stringify({ idDPS: 'x', erros: [{ Codigo: 'E0206', Descricao: 'CPF inválido' }, { codigo: 'E0010', descricao: 'Série' }] }),
      }),
    })
    const client = createSefinClient({ transport: fake.transport })
    const t = tenant()
    const result = await client.emitir({ tenant: t, invoice: invoiceFor(client, t), certificado: sharedTestCertificate().certificado })
    expect(result).toEqual({ kind: 'rejected', code: 'E0206', message: 'E0206: CPF inválido | E0010: Série' })
  })

  it('E999, certificado de transmissão, 5xx e rede viram unavailable', async () => {
    const cert = sharedTestCertificate().certificado
    const t = tenant()
    for (const response of [
      { status: 400, body: JSON.stringify({ erros: [{ Codigo: 'E999', Descricao: 'Erro não catalogado' }] }) },
      { status: 403, body: JSON.stringify({ erros: [{ Codigo: 'E1203', Descricao: 'Certificado expirado' }] }) },
      { status: 500, body: JSON.stringify({ erros: [{ Codigo: 'E999', Descricao: 'falha' }] }) },
      { status: 503, body: '<html>indisponível</html>' },
    ]) {
      const client = createSefinClient({ transport: fakeSefin({ emitir: () => response }).transport })
      const result = await client.emitir({ tenant: t, invoice: invoiceFor(client, t), certificado: cert })
      expect(result.kind, `HTTP ${response.status}`).toBe('unavailable')
    }
    const offline = createSefinClient({ transport: fakeSefin({ networkError: /./ }).transport })
    expect((await offline.emitir({ tenant: t, invoice: invoiceFor(offline, t), certificado: cert })).kind).toBe('unavailable')
  })

  it('E0014 (DPS já gerou NFS-e) consulta e devolve a nota existente', async () => {
    const cert = sharedTestCertificate().certificado
    const fake = fakeSefin()
    const client = createSefinClient({ transport: fake.transport })
    const t = tenant()
    const invoice = invoiceFor(client, t, 7)
    const first = await client.emitir({ tenant: t, invoice, certificado: cert })

    const again = createSefinClient({
      transport: async (request, tls) => {
        if (request.method === 'POST') {
          return { status: 400, body: JSON.stringify({ erros: [{ Codigo: 'E0014', Descricao: 'DPS já existe em NFS-e' }] }) }
        }
        return fake.transport(request, tls)
      },
    })
    const result = await again.emitir({ tenant: t, invoice, certificado: cert })
    expect(result.kind).toBe('authorized')
    expect(result.kind === 'authorized' && first.kind === 'authorized' && result.chaveAcesso === first.chaveAcesso).toBe(true)
  })

  it('dado fora do leiaute vira rejected DPS_INVALID sem transmitir', async () => {
    const fake = fakeSefin()
    const client = createSefinClient({ transport: fake.transport })
    const t = tenant()
    const invoice = { ...invoiceFor(client, t), payload: { ...payload, servico: { ...payload.servico, codigo_servico_nacional: '4.01' } } }
    const result = await client.emitir({ tenant: t, invoice, certificado: sharedTestCertificate().certificado })
    expect(result).toMatchObject({ kind: 'rejected', code: 'DPS_INVALID' })
    expect(fake.requests).toHaveLength(0)
  })

  it('consulta: 404 → not_found; 200 → found com o XML da NFS-e', async () => {
    const cert = sharedTestCertificate().certificado
    const fake = fakeSefin()
    const client = createSefinClient({ transport: fake.transport })
    const t = tenant()
    const invoice = invoiceFor(client, t, 3)
    expect(await client.consultarPorIdDps({ tenant: t, idDps: invoice.id_dps, certificado: cert })).toEqual({ kind: 'not_found' })
    await client.emitir({ tenant: t, invoice, certificado: cert })
    const found = await client.consultarPorIdDps({ tenant: t, idDps: invoice.id_dps, certificado: cert })
    expect(found.kind).toBe('found')
  })
})

describe('evento e101101 pelo cliente real', () => {
  it('transmite o pedido assinado em pedidoRegistroEventoXmlGZipB64', async () => {
    const cert = sharedTestCertificate()
    const fake = fakeSefin()
    const client = createSefinClient({ transport: fake.transport })
    const result = await client.cancelar({ tenant: tenant(), chaveAcesso: CHAVE, certificado: cert.certificado })
    expect(result.kind).toBe('accepted')
    const request = fake.requests[0]
    expect(Object.keys(JSON.parse(request.body!))).toEqual(['pedidoRegistroEventoXmlGZipB64'])
    expect(request.xml).toContain(`<infPedReg Id="PRE${CHAVE}101101">`)
    expect(request.xml).toContain('<e101101><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>9</cMotivo>')
    expect(request.xml).toContain(`<chNFSe>${CHAVE}</chNFSe><e101101>`)
    expect(request.xml).toContain('<CNPJAutor>56210013000140</CNPJAutor>')
    expect(verifySignature(request.xml!, cert.certPem)).toBe(true)
  })

  it('recusa com erro em array vira refused; E999 vira unavailable', async () => {
    const cert = sharedTestCertificate().certificado
    const refused = createSefinClient({
      transport: fakeSefin({
        evento: () => ({ status: 400, body: JSON.stringify({ erro: [{ codigo: 'E0822', descricao: 'Fora do prazo' }] }) }),
      }).transport,
    })
    expect(await refused.cancelar({ tenant: tenant(), chaveAcesso: CHAVE, certificado: cert })).toEqual({
      kind: 'refused',
      code: 'E0822',
      message: 'E0822: Fora do prazo',
    })
    const unstable = createSefinClient({
      transport: fakeSefin({ evento: () => ({ status: 400, body: JSON.stringify({ erro: { codigo: 'E999', descricao: 'x' } }) }) }).transport,
    })
    expect((await unstable.cancelar({ tenant: tenant(), chaveAcesso: CHAVE, certificado: cert })).kind).toBe('unavailable')
  })
})

describe('transporte HTTPS com mTLS (servidor local)', () => {
  const server = makeTestCertificate({ server: true })
  const client = sharedTestCertificate()
  const seen: { authorized: boolean; peerCn: string | undefined; alpn: string | false | null; httpVersion: string }[] = []
  const httpsServer = https.createServer(
    { key: server.keyPem, cert: server.certPem, ca: [client.certPem], requestCert: true, rejectUnauthorized: true },
    (req, res) => {
      const socket = req.socket as TLSSocket
      seen.push({
        authorized: socket.authorized,
        peerCn: String(socket.getPeerCertificate().subject?.CN),
        alpn: socket.alpnProtocol,
        httpVersion: req.httpVersion,
      })
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const { dpsXmlGZipB64 } = JSON.parse(body || '{}') as { dpsXmlGZipB64?: string }
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            chaveAcesso: CHAVE,
            nfseXmlGZipB64: gzipBase64(`<NFSe><echo>${dpsXmlGZipB64 ? gunzipBase64(dpsXmlGZipB64).length : 0}</echo></NFSe>`),
          }),
        )
      })
    },
  )
  const listening = new Promise<number>((resolve) => httpsServer.listen(0, '127.0.0.1', () => resolve((httpsServer.address() as AddressInfo).port)))

  afterAll(() => new Promise<void>((resolve) => httpsServer.close(() => resolve())))

  const toLocal = async (inner: SefinTransport): Promise<SefinTransport> => {
    const port = await listening
    return (request, tls) => inner({ ...request, url: request.url.replace(/^https:\/\/[^/]+/, `https://localhost:${port}`) }, tls)
  }

  it('apresenta o A1 como certificado de cliente, em HTTP/1.1', async () => {
    const transport = await toLocal(httpsTransport({ extraCa: [server.certPem] }))
    const sefin = createSefinClient({ transport })
    const t = tenant()
    const result = await sefin.emitir({ tenant: t, invoice: invoiceFor(sefin, t), certificado: client.certificado })
    expect(result.kind).toBe('authorized')
    expect(seen.at(-1)).toEqual({ authorized: true, peerCn: 'TENANT TESTE:12345678000195', alpn: false, httpVersion: '1.1' })
  })

  it('servidor fora da lista de CAs: unavailable, sem desligar a verificação', async () => {
    const transport = await toLocal(httpsTransport())
    const sefin = createSefinClient({ transport })
    const t = tenant()
    const result = await sefin.emitir({ tenant: t, invoice: invoiceFor(sefin, t), certificado: client.certificado })
    expect(result.kind).toBe('unavailable')
    expect(result.kind === 'unavailable' && /self[- ]signed|certificate/i.test(result.reason)).toBe(true)
  })

  it('cliente sem o A1 aceito pelo servidor não passa do TLS', async () => {
    const stranger = makeTestCertificate({ commonName: 'OUTRO' })
    const transport = await toLocal(httpsTransport({ extraCa: [server.certPem] }))
    const sefin = createSefinClient({ transport })
    const t = tenant()
    const result = await sefin.emitir({ tenant: t, invoice: invoiceFor(sefin, t), certificado: stranger.certificado })
    expect(result.kind).toBe('unavailable')
  })
})
