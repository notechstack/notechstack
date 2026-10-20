// CPF, CNPJ, e-mail e dinheiro na conversa: lidos e escritos por código, nunca pela IA.

function digitoVerificador(base: string, pesos: number[]): number {
  const soma = [...base].reduce((acc, d, i) => acc + Number(d) * pesos[i], 0)
  const resto = soma % 11
  return resto < 2 ? 0 : 11 - resto
}

export function cpfValido(cpf: string): boolean {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false
  const d1 = digitoVerificador(cpf.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2])
  const d2 = digitoVerificador(cpf.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2])
  return cpf.endsWith(`${d1}${d2}`)
}

export function cnpjValido(cnpj: string): boolean {
  if (!/^\d{14}$/.test(cnpj) || /^(\d)\1{13}$/.test(cnpj)) return false
  const d1 = digitoVerificador(cnpj.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])
  const d2 = digitoVerificador(cnpj.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])
  return cnpj.endsWith(`${d1}${d2}`)
}

export const tipoDoDocumento = (documento: string): 'cpf' | 'cnpj' => (documento.length === 14 ? 'cnpj' : 'cpf')

export function formatarDocumento(documento: string): string {
  if (documento.length === 14) {
    return `${documento.slice(0, 2)}.${documento.slice(2, 5)}.${documento.slice(5, 8)}/${documento.slice(8, 12)}-${documento.slice(12)}`
  }
  return `${documento.slice(0, 3)}.${documento.slice(3, 6)}.${documento.slice(6, 9)}-${documento.slice(9)}`
}

const CNPJ_NO_TEXTO = /(?<!\d)\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}(?!\d)/g
const CPF_NO_TEXTO = /(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/g
const EMAIL_NO_TEXTO = /[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>().]+/

/** Primeiro CNPJ ou CPF válido escrito na mensagem (só dígitos), ou `null`. */
export function documentoNoTexto(texto: string): string | null {
  for (const m of texto.matchAll(CNPJ_NO_TEXTO)) {
    const digitos = m[0].replace(/\D/g, '')
    if (cnpjValido(digitos)) return digitos
  }
  for (const m of texto.matchAll(CPF_NO_TEXTO)) {
    const digitos = m[0].replace(/\D/g, '')
    if (cpfValido(digitos)) return digitos
  }
  return null
}

export function emailNoTexto(texto: string): string | null {
  const m = EMAIL_NO_TEXTO.exec(texto)
  if (!m) return null
  const email = m[0].trim().toLowerCase()
  return email.length <= 254 ? email : null
}

/** `"1234.5"` → `"R$ 1.234,50"` (espaço comum, como no texto dos critérios). */
export function formatarReais(valor: string | number): string {
  const [inteiro, centavos = '00'] = (typeof valor === 'number' ? valor.toFixed(2) : valor).split('.')
  const milhares = inteiro.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `R$ ${milhares},${centavos.padEnd(2, '0').slice(0, 2)}`
}
