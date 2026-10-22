// A1 em PKCS#12 → chave e certificado em PEM, só em memória (critério 22). O OpenSSL 3 do
// Node recusa PFX legado (RC2/3DES), comum nos A1 brasileiros; o node-forge abre os dois
// (Landing do checklist, lote 2b - dependências). Nada daqui é gravado ou logado.
import forge from 'node-forge'
import type { Certificado } from './sefin.js'

export type PemCredentials = {
  keyPem: string
  /** Certificado do emitente (o que corresponde à chave). */
  certPem: string
  /** Demais certificados do PFX (cadeia), para o TLS. */
  chainPem: string[]
  notAfter: Date
}

export class CertificateError extends Error {
  readonly code = 'CERT_INVALID'
  constructor(message: string) {
    super(message)
    this.name = 'CertificateError'
  }
}

export function pfxToPem(certificado: Certificado): PemCredentials {
  let p12: forge.pkcs12.Pkcs12Pfx
  try {
    const der = forge.util.decode64(certificado.pfxBase64)
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), false, certificado.password)
  } catch {
    // A mensagem do forge pode ecoar parte do conteúdo; nunca a repassamos.
    throw new CertificateError('não foi possível abrir o PFX do tenant')
  }
  const bagsOf = (type: string) => p12.getBags({ bagType: type })[type] ?? []
  const key = [...bagsOf(forge.pki.oids.pkcs8ShroudedKeyBag), ...bagsOf(forge.pki.oids.keyBag)].find((bag) => bag.key)?.key as
    | forge.pki.rsa.PrivateKey
    | undefined
  const certs = bagsOf(forge.pki.oids.certBag)
    .map((bag) => bag.cert)
    .filter((cert): cert is forge.pki.Certificate => Boolean(cert))
  if (!key || certs.length === 0) throw new CertificateError('o PFX não traz chave privada e certificado')
  const leaf = certs.find((cert) => {
    const publicKey = cert.publicKey as forge.pki.rsa.PublicKey
    return Boolean(publicKey?.n && key.n && publicKey.n.equals(key.n))
  })
  if (!leaf) throw new CertificateError('nenhum certificado do PFX corresponde à chave privada')
  return {
    keyPem: forge.pki.privateKeyToPem(key),
    certPem: forge.pki.certificateToPem(leaf),
    chainPem: certs.filter((cert) => cert !== leaf).map((cert) => forge.pki.certificateToPem(cert)),
    notAfter: leaf.validity.notAfter,
  }
}
