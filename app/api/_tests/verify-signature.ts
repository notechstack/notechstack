// Verificação da assinatura XMLDSig nos testes, com o xml-crypto e o certificado do teste.
import { DOMParser } from '@xmldom/xmldom'
import { SignedXml } from 'xml-crypto'

const DSIG = 'http://www.w3.org/2000/09/xmldsig#'

export function verifySignature(xml: string, certPem: string): boolean {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  const signature = doc.getElementsByTagNameNS(DSIG, 'Signature')[0]
  if (!signature) return false
  const verifier = new SignedXml({ publicCert: certPem, getCertFromKeyInfo: () => null })
  verifier.loadSignature(signature as unknown as Node)
  return verifier.checkSignature(xml)
}
