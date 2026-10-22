// Certificados de teste, gerados no próprio teste: nenhum A1 real entra no repositório nem no
// teste. A chave RSA sai do `node:crypto` (rápido) e o certificado e o PFX do node-forge, com
// cifra 3DES, como os A1 brasileiros em PKCS#12 legado.
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import forge from 'node-forge'
import type { Certificado } from '../_lib/sefin.js'

export type TestCertificate = {
  certificado: Certificado
  certPem: string
  keyPem: string
}

export type TestCertificateOptions = {
  commonName?: string
  notAfter?: Date
  /** Certificado de servidor TLS (SAN localhost/127.0.0.1); padrão: certificado de cliente/assinatura. */
  server?: boolean
}

export function makeTestCertificate(options: TestCertificateOptions = {}): TestCertificate {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  })
  const forgeKey = forge.pki.privateKeyFromPem(privateKey)
  const cert = forge.pki.createCertificate()
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey)
  cert.serialNumber = `01${randomBytes(8).toString('hex')}`
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600_000)
  cert.validity.notAfter = options.notAfter ?? new Date(Date.now() + 365 * 24 * 3600_000)
  const attrs = [
    { name: 'commonName', value: options.commonName ?? (options.server ? 'localhost' : 'TENANT TESTE:12345678000195') },
    { name: 'countryName', value: 'BR' },
    { name: 'organizationName', value: 'ICP-Brasil (teste)' },
  ]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true, keyEncipherment: true },
    { name: 'extKeyUsage', clientAuth: true, serverAuth: Boolean(options.server) },
    ...(options.server
      ? [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] }]
      : []),
  ])
  cert.sign(forgeKey, forge.md.sha256.create())

  const password = `senha-${randomBytes(6).toString('hex')}`
  const p12 = forge.pkcs12.toPkcs12Asn1(forgeKey, [cert], password, { algorithm: '3des' })
  const pfxBase64 = forge.util.encode64(forge.asn1.toDer(p12).getBytes())
  return { certificado: { pfxBase64, password }, certPem: forge.pki.certificateToPem(cert), keyPem: privateKey }
}

let shared: TestCertificate | undefined
/** Um A1 de teste reaproveitado entre testes do mesmo arquivo (gerar RSA custa ~100 ms). */
export function sharedTestCertificate(): TestCertificate {
  shared ??= makeTestCertificate()
  return shared
}
