// Normalização dos dados de contato do agente (Landing, lote A - hash do teste grátis):
// CPF e CNPJ só dígitos, e-mail com trim e minúsculas, telefone em E.164 (+55 quando vêm
// 10 ou 11 dígitos, que é como se escreve um número brasileiro sem o país).
const E164 = /^\+[1-9][0-9]{7,14}$/
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export function normalizarEmail(valor: string): string | null {
  const email = valor.trim().toLowerCase()
  return email.length <= 254 && EMAIL.test(email) ? email : null
}

export function normalizarTelefone(valor: string): string | null {
  const texto = valor.trim()
  const digitos = texto.replace(/\D/g, '')
  let e164: string
  if (texto.startsWith('+')) e164 = `+${digitos}`
  else if (digitos.length === 10 || digitos.length === 11) e164 = `+55${digitos}`
  else if (digitos.startsWith('55') && (digitos.length === 12 || digitos.length === 13)) e164 = `+${digitos}`
  else return null
  return E164.test(e164) ? e164 : null
}

export function normalizarDocumento(valor: string, tamanho: 11 | 14): string | null {
  const digitos = valor.replace(/\D/g, '')
  return digitos.length === tamanho ? digitos : null
}
