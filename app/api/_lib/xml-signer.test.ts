// Assinatura da DPS no perfil do Landing (lote 2b - perfil da assinatura), verificada com o
// próprio xml-crypto, com um A1 autoassinado gerado no teste (PFX 3DES aberto pelo node-forge).
import { DOMParser } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import { makeTestCertificate, sharedTestCertificate } from '../_tests/certs.js'
import { verifySignature } from '../_tests/verify-signature.js'
import { buildDps } from './dps-builder.js'
import { buildPedidoCancelamento } from './evento-builder.js'
import { pfxToPem } from './pfx.js'
import type { SefinTenant } from './sefin.js'
import { signXml, type SignatureProfile } from './xml-signer.js'

const DSIG = 'http://www.w3.org/2000/09/xmldsig#'
const tenant: SefinTenant = {
  id: 't-1',
  cnpj: '56210013000140',
  razao_social: 'PRIMECARE',
  inscricao_municipal: null,
  codigo_municipio_ibge: '3550308',
  regime: 'simples',
  ambiente: 'producao_restrita',
  p_tot_trib_sn: '6.00',
}
const payload = {
  tomador: { cpf: '12345678909', nome: 'Maria da Silva' },
  servico: { codigo_servico_nacional: '040101', descricao: 'Consulta' },
  valor: '42.90',
}

function signedDps(profile?: SignatureProfile) {
  const cert = sharedTestCertificate()
  const pem = pfxToPem(cert.certificado)
  const { id, xml } = buildDps({ tenant, serie: '1', numero: 9, payload, now: new Date('2026-11-03T13:00:00Z') })
  return { id, cert, signed: signXml({ xml, signedElement: 'infDPS', keyPem: pem.keyPem, certPem: pem.certPem, profile }) }
}

describe('xml-signer', () => {
  it('assina infDPS no perfil RSA-SHA256 + exc-c14n e verifica', () => {
    const { id, cert, signed } = signedDps()
    expect(verifySignature(signed, cert.certPem)).toBe(true)

    const doc = new DOMParser().parseFromString(signed, 'text/xml')
    const root = doc.documentElement
    const children = Array.from(root.childNodes) as Element[]
    // <Signature> sem prefixo, irmão de infDPS, logo depois dele.
    expect(children.map((c) => c.localName)).toEqual(['infDPS', 'Signature'])
    expect(children[1].namespaceURI).toBe(DSIG)
    expect(children[1].prefix ?? null).toBeNull()
    expect(signed).not.toMatch(/<ds:|xmlns:ds=/)
    expect(signed).toContain(`<Reference URI="#${id}">`)
    expect(signed).toContain('<SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>')
    expect(signed).toContain('<CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>')
    expect(signed).toContain('<DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>')
    expect(signed).toContain('<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>')
    // Só o certificado do emitente no KeyInfo.
    const certs = doc.getElementsByTagNameNS(DSIG, 'X509Certificate')
    expect(certs).toHaveLength(1)
    const pemBody = cert.certPem.replace(/-----[^-]+-----|\s/g, '')
    expect(certs[0].textContent).toBe(pemBody)
  })

  it('o XML assinado não é reformatado: o infDPS assinado é o texto montado', () => {
    const cert = sharedTestCertificate()
    const pem = pfxToPem(cert.certificado)
    const { xml } = buildDps({ tenant, serie: '1', numero: 9, payload, now: new Date('2026-11-03T13:00:00Z') })
    const signed = signXml({ xml, signedElement: 'infDPS', keyPem: pem.keyPem, certPem: pem.certPem })
    const infDps = /<infDPS[\s\S]*<\/infDPS>/.exec(xml)![0]
    expect(signed).toContain(infDps)
    expect(signed).not.toMatch(/>\s+</)
    // Uma alteração depois de assinar quebra a verificação (o que a Sefin acusa com E0714).
    expect(verifySignature(signed.replace('<nDPS>9</nDPS>', '<nDPS>10</nDPS>'), cert.certPem)).toBe(false)
  })

  it('plano B do spike: C14N 1.0 + RSA-SHA1 também verifica', () => {
    const { cert, signed } = signedDps('sha1-c14n')
    expect(signed).toContain('<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/>')
    expect(verifySignature(signed, cert.certPem)).toBe(true)
  })

  it('assina o pedido de cancelamento em infPedReg', () => {
    const cert = sharedTestCertificate()
    const pem = pfxToPem(cert.certificado)
    const chave = '3550308225621001300014000000000000012611123456789'.padEnd(50, '0')
    const pedido = buildPedidoCancelamento({ tenant, chaveAcesso: chave, now: new Date('2026-11-04T13:00:00Z') })
    const signed = signXml({ xml: pedido.xml, signedElement: 'infPedReg', keyPem: pem.keyPem, certPem: pem.certPem })
    expect(pedido.id).toBe(`PRE${chave}101101`)
    expect(pedido.id).toHaveLength(59)
    expect(signed).toContain(`<Reference URI="#${pedido.id}">`)
    expect(verifySignature(signed, cert.certPem)).toBe(true)
  })

  it('pfxToPem abre PFX 3DES e recusa senha errada sem ecoar a senha', () => {
    const cert = makeTestCertificate()
    const pem = pfxToPem(cert.certificado)
    expect(pem.keyPem).toMatch(/BEGIN RSA PRIVATE KEY/)
    expect(pem.certPem.replace(/\r/g, '')).toBe(cert.certPem.replace(/\r/g, ''))
    const wrong = 'senha-errada-123'
    expect(() => pfxToPem({ pfxBase64: cert.certificado.pfxBase64, password: wrong })).toThrow(/não foi possível abrir o PFX/)
    try {
      pfxToPem({ pfxBase64: cert.certificado.pfxBase64, password: wrong })
    } catch (error) {
      expect(String(error)).not.toContain(wrong)
      expect(String(error)).not.toContain(cert.certificado.pfxBase64.slice(0, 40))
    }
  })
})
