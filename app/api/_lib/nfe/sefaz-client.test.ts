// Cliente SOAP da NF-e contra um transporte dublê: nenhum teste chama a Sefaz.
import { describe, expect, it } from 'vitest'
import { makeTestCertificate } from '../../_tests/certs.js'
import { verifySignature } from '../../_tests/verify-signature.js'
import type { HttpRequest, HttpResponse, SefinTransport } from '../sefin-client.js'
import { montarNfe } from './nfe-builder.js'
import { EMITENTE_SP, notaExemplo } from './nfe-fixtures.js'
import { pedidoCancelamento, pedidoCartaCorrecao, pedidoInutilizacao } from './pedidos.js'
import { abrirCertificado, cnpjDoCertificado, criarSefazClient, type Credencial } from './sefaz-client.js'

const NS = 'http://www.portalfiscal.inf.br/nfe'
const soap = (corpo: string) =>
  `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body>` +
  `<nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/X">${corpo}</nfeResultMsg></soap:Body></soap:Envelope>`
const prot = (chave: string, cStat: string, motivo: string, nProt = '135260000012345') =>
  `<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>SP_NFE_PL009_V4</verAplic><chNFe>${chave}</chNFe>` +
  `<dhRecbto>2026-11-16T12:30:05-03:00</dhRecbto><nProt>${nProt}</nProt><digVal>abc=</digVal><cStat>${cStat}</cStat><xMotivo>${motivo}</xMotivo></infProt></protNFe>`

function dublê(responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>) {
  const chamadas: HttpRequest[] = []
  const transport: SefinTransport = async (req) => {
    chamadas.push(req)
    return responder(req)
  }
  return { transport, chamadas }
}

const cert = makeTestCertificate({ commonName: 'COMERCIO EXEMPLO BRAGANCA LTDA:12345678000195' })
const cred = abrirCertificado(cert.certificado, EMITENTE_SP.cnpj) as Credencial

describe('certificado do emitente', () => {
  it('lê o CNPJ do CN do e-CNPJ', () => {
    expect(cnpjDoCertificado(cert.certPem)).toBe('12345678000195')
  })

  it('abre o A1 do próprio emitente (mesma raiz de CNPJ, inclusive filial)', () => {
    expect('pem' in cred).toBe(true)
    expect('pem' in abrirCertificado(cert.certificado, '12.345.678/0002-76')).toBe(true)
  })

  it('recusa A1 de outro CNPJ: a nota nunca sai assinada pelo escritório ou pela nó', () => {
    const doEscritorio = makeTestCertificate({ commonName: 'ESCRITORIO CONTABIL:11222333000181' })
    const r = abrirCertificado(doEscritorio.certificado, EMITENTE_SP.cnpj)
    expect(r).toEqual({ erro: expect.stringMatching(/^CERT_DE_OUTRO_CNPJ/) })
  })

  it('recusa certificado sem CNPJ', () => {
    const semCnpj = makeTestCertificate({ commonName: 'FULANO DE TAL' })
    expect(abrirCertificado(semCnpj.certificado, EMITENTE_SP.cnpj)).toEqual({ erro: expect.stringMatching(/^CERT_SEM_CNPJ/) })
  })
})

describe('autorização', () => {
  const { xml, chave } = montarNfe(notaExemplo())

  it('SP: envelope SOAP 1.2 com action, URL da Sefaz-SP, NF-e assinada no lote síncrono, mTLS com o A1', async () => {
    const d = dublê(() => ({ status: 200, body: soap(`<retEnviNFe xmlns="${NS}" versao="4.00"><cStat>104</cStat><xMotivo>Lote processado</xMotivo>${prot(chave, '100', 'Autorizado o uso da NF-e')}</retEnviNFe>`) }))
    const sefaz = criarSefazClient({ transport: d.transport })
    const assinada = sefaz.assinarNfe(xml, cred)
    const r = await sefaz.autorizar('SP', 'homologacao', assinada, cred, '1')
    expect(r).toMatchObject({ kind: 'autorizada', chave, protocolo: '135260000012345', cStat: '100' })
    const req = d.chamadas[0]
    expect(req.url).toBe('https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx')
    expect(req.headers['content-type']).toBe(
      'application/soap+xml; charset=utf-8; action="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4/nfeAutorizacaoLote"',
    )
    expect(req.body).toContain('<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">')
    expect(req.body).toContain(`<enviNFe xmlns="${NS}" versao="4.00"><idLote>1</idLote><indSinc>1</indSinc><NFe xmlns="${NS}">`)
    const nfe = /<NFe xmlns[\s\S]*<\/NFe>/.exec(req.body ?? '')![0]
    expect(verifySignature(nfe, cert.certPem)).toBe(true)
    if (r.kind === 'autorizada') {
      expect(r.xmlProc.startsWith(`<nfeProc xmlns="${NS}" versao="4.00"><NFe`)).toBe(true)
      expect(r.xmlProc).toContain('<nProt>135260000012345</nProt>')
      expect(verifySignature(r.xmlProc, cert.certPem)).toBe(true)
    }
  })

  it('MA vai para a SVAN, RJ para a SVRS, MG para a Sefaz-MG', async () => {
    const d = dublê(() => ({ status: 200, body: soap(`<retEnviNFe xmlns="${NS}"><cStat>104</cStat><xMotivo>ok</xMotivo>${prot(chave, '100', 'ok')}</retEnviNFe>`) }))
    const sefaz = criarSefazClient({ transport: d.transport })
    await sefaz.autorizar('MA', 'producao', xml, cred)
    await sefaz.autorizar('RJ', 'producao', xml, cred)
    await sefaz.autorizar('MG', 'homologacao', xml, cred)
    expect(d.chamadas.map((c) => c.url)).toEqual([
      'https://www.sefazvirtual.fazenda.gov.br/NFeAutorizacao4/NFeAutorizacao4.asmx',
      'https://nfe.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
      'https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeAutorizacao4',
    ])
  })

  it('rejeição no protocolo volta com o código e o motivo', async () => {
    const d = dublê(() => ({ status: 200, body: soap(`<retEnviNFe xmlns="${NS}"><cStat>104</cStat><xMotivo>Lote processado</xMotivo>${prot(chave, '778', 'Rejeicao: Informado NCM inexistente', '')}</retEnviNFe>`) }))
    const r = await criarSefazClient({ transport: d.transport }).autorizar('SP', 'homologacao', xml, cred)
    expect(r).toEqual({ kind: 'rejeitada', cStat: '778', motivo: 'Rejeicao: Informado NCM inexistente' })
  })

  it('rejeição do lote (sem protocolo)', async () => {
    const d = dublê(() => ({ status: 200, body: soap(`<retEnviNFe xmlns="${NS}"><cStat>215</cStat><xMotivo>Rejeicao: Falha no schema XML</xMotivo></retEnviNFe>`) }))
    const r = await criarSefazClient({ transport: d.transport }).autorizar('SP', 'homologacao', xml, cred)
    expect(r).toEqual({ kind: 'rejeitada', cStat: '215', motivo: 'Rejeicao: Falha no schema XML' })
  })

  it('uso denegado guarda o nfeProc (o número foi consumido)', async () => {
    const d = dublê(() => ({ status: 200, body: soap(`<retEnviNFe xmlns="${NS}"><cStat>104</cStat><xMotivo>ok</xMotivo>${prot(chave, '302', 'Uso Denegado: Irregularidade fiscal do destinatario')}</retEnviNFe>`) }))
    const r = await criarSefazClient({ transport: d.transport }).autorizar('SP', 'homologacao', xml, cred)
    expect(r.kind).toBe('denegada')
  })

  it('lote assíncrono (103) devolve o recibo; a consulta do recibo traz o protocolo', async () => {
    let n = 0
    const d = dublê(() => {
      n++
      if (n === 1) return { status: 200, body: soap(`<retEnviNFe xmlns="${NS}"><cStat>103</cStat><xMotivo>Lote recebido</xMotivo><infRec><nRec>351000012345678</nRec></infRec></retEnviNFe>`) }
      if (n === 2) return { status: 200, body: soap(`<retConsReciNFe xmlns="${NS}"><cStat>105</cStat><xMotivo>Lote em processamento</xMotivo></retConsReciNFe>`) }
      return { status: 200, body: soap(`<retConsReciNFe xmlns="${NS}"><nRec>351000012345678</nRec><cStat>104</cStat><xMotivo>ok</xMotivo>${prot(chave, '100', 'Autorizado')}</retConsReciNFe>`) }
    })
    const sefaz = criarSefazClient({ transport: d.transport })
    expect(await sefaz.autorizar('SP', 'homologacao', xml, cred)).toEqual({ kind: 'em_processamento', recibo: '351000012345678' })
    expect(await sefaz.consultarRecibo('SP', 'homologacao', '351000012345678', xml, cred)).toEqual({ kind: 'em_processamento', recibo: '351000012345678' })
    expect((await sefaz.consultarRecibo('SP', 'homologacao', '351000012345678', xml, cred)).kind).toBe('autorizada')
    expect(d.chamadas[1].body).toContain('<consReciNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><tpAmb>2</tpAmb><nRec>351000012345678</nRec></consReciNFe>')
  })

  it('falha de rede e HTTP 500 sem XML viram "indisponível" (a nota volta para a fila)', async () => {
    const rede = dublê(() => { throw new Error('timeout de 30000 ms') })
    expect(await criarSefazClient({ transport: rede.transport }).autorizar('SP', 'homologacao', xml, cred)).toEqual({
      kind: 'indisponivel',
      motivo: 'SP autorizacao: timeout de 30000 ms',
    })
    const http = dublê(() => ({ status: 503, body: 'Service Unavailable' }))
    expect(await criarSefazClient({ transport: http.transport }).autorizar('SP', 'homologacao', xml, cred)).toEqual({
      kind: 'indisponivel',
      motivo: 'SP autorizacao: HTTP 503',
    })
  })

  it('consulta pela chave: 217 = não existe (pode reenviar); com protocolo = já autorizada', async () => {
    const nao = dublê(() => ({ status: 200, body: soap(`<retConsSitNFe xmlns="${NS}"><cStat>217</cStat><xMotivo>Rejeicao: NF-e nao consta na base de dados da SEFAZ</xMotivo></retConsSitNFe>`) }))
    expect(await criarSefazClient({ transport: nao.transport }).consultarChave('SP', 'homologacao', chave, xml, cred)).toEqual({ kind: 'nao_encontrada' })
    const sim = dublê(() => ({ status: 200, body: soap(`<retConsSitNFe xmlns="${NS}"><cStat>100</cStat><xMotivo>Autorizado</xMotivo>${prot(chave, '100', 'Autorizado')}</retConsSitNFe>`) }))
    expect((await criarSefazClient({ transport: sim.transport }).consultarChave('SP', 'homologacao', chave, xml, cred)).kind).toBe('autorizada')
  })
})

describe('eventos, inutilização e status', () => {
  const { chave } = montarNfe(notaExemplo())
  const base = { ambiente: 'homologacao' as const, uf: 'SP' as const, cnpj: EMITENTE_SP.cnpj, chave, quando: new Date('2026-11-16T16:00:00Z') }
  const retEvento = (cStat: string) =>
    soap(`<retEnvEvento xmlns="${NS}" versao="1.00"><idLote>1</idLote><cStat>128</cStat><xMotivo>Lote de Evento Processado</xMotivo>` +
      `<retEvento versao="1.00"><infEvento><tpAmb>2</tpAmb><cOrgao>35</cOrgao><cStat>${cStat}</cStat><xMotivo>Evento registrado e vinculado a NF-e</xMotivo>` +
      `<chNFe>${chave}</chNFe><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><nProt>135260000099999</nProt></infEvento></retEvento></retEnvEvento>`)

  it('cancelamento: Id, assinatura do infEvento e procEventoNFe', async () => {
    const d = dublê(() => ({ status: 200, body: retEvento('135') }))
    const pedido = pedidoCancelamento({ ...base, protocolo: '135260000012345', justificativa: 'Erro na digitacao do valor' })
    expect(pedido.id).toBe(`ID110111${chave}01`)
    const r = await criarSefazClient({ transport: d.transport }).evento('SP', 'homologacao', pedido, cred)
    expect(r).toMatchObject({ kind: 'registrado', protocolo: '135260000099999', cStat: '135' })
    expect(d.chamadas[0].url).toBe('https://homologacao.nfe.fazenda.sp.gov.br/ws/nferecepcaoevento4.asmx')
    expect(d.chamadas[0].body).toContain('<descEvento>Cancelamento</descEvento><nProt>135260000012345</nProt>')
    const evento = /<evento [\s\S]*<\/evento>/.exec(d.chamadas[0].body ?? '')![0]
    expect(verifySignature(evento, cert.certPem)).toBe(true)
  })

  it('evento rejeitado (ex.: prazo de cancelamento vencido)', async () => {
    const d = dublê(() => ({ status: 200, body: retEvento('501') }))
    const pedido = pedidoCancelamento({ ...base, protocolo: '135260000012345', justificativa: 'Erro na digitacao do valor' })
    expect((await criarSefazClient({ transport: d.transport }).evento('SP', 'homologacao', pedido, cred)).kind).toBe('rejeitado')
  })

  it('carta de correção com sequência e o texto fixo de condições de uso', () => {
    const p = pedidoCartaCorrecao({ ...base, sequencia: 3, correcao: 'Endereco do destinatario: numero 1000, nao 100.' })
    expect(p.id).toBe(`ID110110${chave}03`)
    expect(p.xml).toContain('<xCondUso>A Carta de Correcao e disciplinada')
    expect(() => pedidoCartaCorrecao({ ...base, correcao: 'curto' })).toThrow()
  })

  it('inutilização: Id no formato do leiaute e protocolo 102', async () => {
    const d = dublê(() => ({ status: 200, body: soap(`<retInutNFe xmlns="${NS}" versao="4.00"><infInut><tpAmb>2</tpAmb><cStat>102</cStat><xMotivo>Inutilizacao de numero homologado</xMotivo><nProt>135260000077777</nProt></infInut></retInutNFe>`) }))
    const pedido = pedidoInutilizacao({ ambiente: 'homologacao', uf: 'SP', cnpj: EMITENTE_SP.cnpj, ano: 2026, serie: 1, inicio: 10, fim: 12, justificativa: 'Numeracao pulada por falha no sistema' })
    expect(pedido.id).toBe('ID352612345678000195550010000000100000000' + '12')
    const r = await criarSefazClient({ transport: d.transport }).inutilizar('SP', 'homologacao', pedido, cred)
    expect(r).toMatchObject({ kind: 'homologada', protocolo: '135260000077777' })
  })

  it('status do serviço: 107 em operação', async () => {
    const d = dublê(() => ({ status: 200, body: soap(`<retConsStatServ xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><cStat>107</cStat><xMotivo>Servico em Operacao</xMotivo></retConsStatServ>`) }))
    expect(await criarSefazClient({ transport: d.transport }).status('BA', 'homologacao', cred)).toEqual({ kind: 'ok', cStat: '107', motivo: 'Servico em Operacao' })
    expect(d.chamadas[0].body).toContain('<consStatServ xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><tpAmb>2</tpAmb><cUF>29</cUF><xServ>STATUS</xServ></consStatServ>')
  })
})
