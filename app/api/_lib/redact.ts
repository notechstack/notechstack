// Nada que vá para o banco ou para log pode conter o PFX ou a senha do A1 (critério 22).
// Tudo o que vem de terceiros (Sefin, biblioteca de assinatura) passa por aqui antes de
// virar `last_error` ou `xml_*`: uma biblioteca que despeje as opções num erro não vaza
// o certificado.
import type { Certificado } from './sefin.js'

export const MAX_ERROR_LENGTH = 1000

export function redactCertificate(text: string, certificado: Certificado | null, maxLength?: number): string {
  let out = text
  if (certificado) {
    for (const secret of [certificado.pfxBase64, certificado.password]) {
      if (secret) out = out.split(secret).join('[redacted]')
    }
  }
  return maxLength !== undefined && out.length > maxLength ? `${out.slice(0, maxLength)}…` : out
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}
