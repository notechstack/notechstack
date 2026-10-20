// Assinatura XMLDSig da DPS (`infDPS`) e do pedido de evento (`infPedReg`). Perfil no Landing
// do checklist (lote 2b - perfil da assinatura): RSA-SHA256 + SHA-256 + exc-c14n,
// `<Signature>` sem prefixo logo depois do elemento assinado, `Reference URI="#<Id>"` e só o
// certificado do emitente no KeyInfo. O texto devolvido não pode ser reformatado depois
// (E0714): é ele que vai para o gzip e para `xml_dps`.
import { SignedXml } from 'xml-crypto'

export type SignatureProfile = 'sha256-exc-c14n' | 'sha1-c14n'

const PROFILES: Record<
  SignatureProfile,
  { signature: string; canonicalization: string; digest: string; transforms: string[] }
> = {
  'sha256-exc-c14n': {
    signature: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalization: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    digest: 'http://www.w3.org/2001/04/xmlenc#sha256',
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
  },
  // Plano B do spike: o perfil que o XSD 1.00 fixava.
  'sha1-c14n': {
    signature: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
    canonicalization: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
    digest: 'http://www.w3.org/2000/09/xmldsig#sha1',
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'],
  },
}

export const DEFAULT_SIGNATURE_PROFILE: SignatureProfile = 'sha256-exc-c14n'

export type SignInput = {
  xml: string
  /** Elemento com atributo `Id` a assinar: `infDPS` ou `infPedReg`. */
  signedElement: 'infDPS' | 'infPedReg'
  keyPem: string
  certPem: string
  profile?: SignatureProfile
}

export function signXml({ xml, signedElement, keyPem, certPem, profile = DEFAULT_SIGNATURE_PROFILE }: SignInput): string {
  const id = new RegExp(`<${signedElement}[\\s][^>]*Id="([^"]+)"`).exec(xml)?.[1]
  if (!id) throw new Error(`<${signedElement}> sem atributo Id`)
  if (/<(?:\w+:)?Signature\b/.test(xml)) throw new Error('o XML já tem assinatura')
  const algorithms = PROFILES[profile]
  const signer = new SignedXml({
    privateKey: keyPem,
    publicCert: certPem,
    signatureAlgorithm: algorithms.signature,
    canonicalizationAlgorithm: algorithms.canonicalization,
  })
  signer.addReference({
    xpath: `//*[local-name(.)='${signedElement}']`,
    transforms: algorithms.transforms,
    digestAlgorithm: algorithms.digest,
    uri: `#${id}`,
  })
  signer.computeSignature(xml, {
    location: { reference: `//*[local-name(.)='${signedElement}']`, action: 'after' },
  })
  return signer.getSignedXml()
}
