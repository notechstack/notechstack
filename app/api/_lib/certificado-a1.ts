// Leitura do A1 enviado no cadastro: abre o PKCS#12 só em memória, com o MAC conferido
// (senha errada não passa como "PFX sem chave"), e devolve titular e validade. Nada daqui
// é gravado ou logado; mensagens do node-forge nunca são repassadas.
import forge from 'node-forge'

export type LeituraDoA1 =
  | { ok: true; subject: string; notAfter: Date }
  | { ok: false; motivo: 'ARQUIVO_INVALIDO' | 'SENHA_INVALIDA' }

function subjectDe(cert: forge.pki.Certificate): string {
  return cert.subject.attributes
    .map((attr) => `${attr.shortName ?? attr.name ?? attr.type}=${String(attr.value)}`)
    .join(', ')
}

export function lerCertificadoA1(pfx: Uint8Array, senha: string): LeituraDoA1 {
  let asn1: forge.asn1.Asn1
  try {
    asn1 = forge.asn1.fromDer(forge.util.createBuffer(Buffer.from(pfx).toString('binary')))
  } catch {
    return { ok: false, motivo: 'ARQUIVO_INVALIDO' }
  }
  let p12: forge.pkcs12.Pkcs12Pfx
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, true, senha)
  } catch {
    return { ok: false, motivo: 'SENHA_INVALIDA' }
  }
  const bagsOf = (type: string) => p12.getBags({ bagType: type })[type] ?? []
  const key = [...bagsOf(forge.pki.oids.pkcs8ShroudedKeyBag), ...bagsOf(forge.pki.oids.keyBag)].find((bag) => bag.key)
    ?.key as forge.pki.rsa.PrivateKey | undefined
  const certs = bagsOf(forge.pki.oids.certBag)
    .map((bag) => bag.cert)
    .filter((cert): cert is forge.pki.Certificate => Boolean(cert))
  if (!key) return { ok: false, motivo: 'SENHA_INVALIDA' }
  const leaf = certs.find((cert) => {
    const publicKey = cert.publicKey as forge.pki.rsa.PublicKey
    return Boolean(publicKey?.n && key.n && publicKey.n.equals(key.n))
  })
  if (!leaf) return { ok: false, motivo: 'ARQUIVO_INVALIDO' }
  return { ok: true, subject: subjectDe(leaf), notAfter: leaf.validity.notAfter }
}
