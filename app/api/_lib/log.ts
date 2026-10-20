// Log estruturado do motor. Só recebe campos escalares escolhidos por quem chama
// (ids, códigos, contagens): nunca payload, XML, mensagem de erro de terceiro ou
// material de certificado (critério 22).
export type LogFields = Record<string, string | number | boolean | null>

export function logEvent(event: string, fields: LogFields = {}): void {
  console.log(JSON.stringify({ event, ...fields }))
}
