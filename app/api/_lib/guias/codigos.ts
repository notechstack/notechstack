// Linha digitável e código de barras das guias (módulo Guias, critério 9). Dois formatos da Febraban:
// - Boleto bancário: linha de 47 dígitos (5 campos), código de barras de 44 com banco, moeda, DV geral (módulo 11),
//   fator de vencimento (4) e valor (10). O fator chegou a 9999 em 21/02/2025 e recomeçou em 1000 em 22/02/2025.
// - Código de arrecadação (tributos, concessionárias): começa com 8; linha de 48 dígitos (4 blocos de 11 + DV) e
//   código de 44 com produto 8, segmento, identificador do valor (6/7 = módulo 10, 8/9 = módulo 11), DV geral e
//   valor (11 dígitos) quando o identificador é 6 ou 8.
// Tudo puro, sem rede. As funções `montar*` existem para os testes e a demonstração gerarem guias sintéticas.

export type CodigoLido =
  | { tipo: 'boleto'; linha: string; codigoBarras: string; valorCentavos: number | null; vencimento: string | null }
  | { tipo: 'arrecadacao'; linha: string; codigoBarras: string; valorCentavos: number | null; segmento: string }

const soDigitos = (v: string) => v.replace(/\D/g, '')

/** Módulo 10 (pesos 2,1,2,1… da direita; soma dos algarismos do produto). */
export function modulo10(numero: string): number {
  let soma = 0
  let peso = 2
  for (let i = numero.length - 1; i >= 0; i--) {
    const p = Number(numero[i]) * peso
    soma += p > 9 ? Math.floor(p / 10) + (p % 10) : p
    peso = peso === 2 ? 1 : 2
  }
  return (10 - (soma % 10)) % 10
}

/** Módulo 11 com pesos 2..9 da direita: o resto bruto (quem chama decide o DV). */
function resto11(numero: string): number {
  let soma = 0
  let peso = 2
  for (let i = numero.length - 1; i >= 0; i--) {
    soma += Number(numero[i]) * peso
    peso = peso === 9 ? 2 : peso + 1
  }
  return soma % 11
}

/** DV do código de arrecadação em módulo 11: resto 0 ou 1 → 0; senão 11 − resto. */
export function modulo11Arrecadacao(numero: string): number {
  const r = resto11(numero)
  return r === 0 || r === 1 ? 0 : 11 - r
}

/** DV geral do boleto (módulo 11): 0, 10 e 11 viram 1. */
export function modulo11Boleto(numero: string): number {
  const dv = 11 - resto11(numero)
  return dv === 0 || dv === 10 || dv === 11 ? 1 : dv
}

const dvArrecadacao = (identificador: string) => (identificador === '8' || identificador === '9' ? modulo11Arrecadacao : modulo10)

// ------------------------------------------------------------------ Fator de vencimento

const DIA_MS = 86_400_000
const BASE_ANTIGA = Date.UTC(1997, 9, 7) // fator 0
const BASE_NOVA = Date.UTC(2025, 1, 22) // fator 1000 (recomeço)

const isoDe = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** Data do fator (1000..9999). Do ciclo antigo ou do novo, o que ficar mais perto de `referencia`. */
export function vencimentoDoFator(fator: number, referencia: Date = new Date()): string | null {
  if (!Number.isInteger(fator) || fator < 1000 || fator > 9999) return null
  const antiga = BASE_ANTIGA + fator * DIA_MS
  const nova = BASE_NOVA + (fator - 1000) * DIA_MS
  const ref = referencia.getTime()
  return isoDe(Math.abs(nova - ref) <= Math.abs(antiga - ref) ? nova : antiga)
}

/** Fator de uma data do ciclo novo (a partir de 22/02/2025). */
export function fatorDaData(iso: string): number {
  const ms = Date.parse(`${iso}T00:00:00Z`)
  const dias = Math.round((ms - BASE_NOVA) / DIA_MS)
  if (dias < 0 || dias > 8999) throw new RangeError('data fora do ciclo do fator')
  return 1000 + dias
}

// ------------------------------------------------------------------ Boleto

/** Linha de 47 dígitos → código de barras de 44, se os 3 DVs dos campos e o DV geral baterem. */
export function lerLinhaBoleto(linha: string, referencia?: Date): CodigoLido | null {
  const l = soDigitos(linha)
  if (l.length !== 47) return null
  const c1 = l.slice(0, 9)
  const c2 = l.slice(10, 20)
  const c3 = l.slice(21, 31)
  if (modulo10(c1) !== Number(l[9]) || modulo10(c2) !== Number(l[20]) || modulo10(c3) !== Number(l[31])) return null
  const codigo = l.slice(0, 4) + l[32] + l.slice(33, 47) + c1.slice(4) + c2 + c3
  if (modulo11Boleto(codigo.slice(0, 4) + codigo.slice(5)) !== Number(codigo[4])) return null
  const fator = Number(codigo.slice(5, 9))
  const valor = Number(codigo.slice(9, 19))
  return {
    tipo: 'boleto',
    linha: l,
    codigoBarras: codigo,
    valorCentavos: valor > 0 ? valor : null,
    vencimento: fator === 0 ? null : vencimentoDoFator(fator, referencia),
  }
}

/** Boleto sintético (testes e demonstração): banco, vencimento (ciclo novo), valor e campo livre de 25 dígitos. */
export function montarBoleto(opcoes: { banco?: string; vencimento: string; valorCentavos: number; livre?: string }): {
  codigoBarras: string
  linha: string
} {
  const banco = (opcoes.banco ?? '237').padStart(3, '0')
  const livre = (opcoes.livre ?? '3381286008200000000000001').padStart(25, '0').slice(0, 25)
  const fator = String(fatorDaData(opcoes.vencimento)).padStart(4, '0')
  const valor = String(opcoes.valorCentavos).padStart(10, '0')
  const semDv = `${banco}9${fator}${valor}${livre}`
  const dv = modulo11Boleto(semDv)
  const codigo = `${banco}9${dv}${fator}${valor}${livre}`
  const c1 = codigo.slice(0, 4) + codigo.slice(19, 24)
  const c2 = codigo.slice(24, 34)
  const c3 = codigo.slice(34, 44)
  const linha = `${c1}${modulo10(c1)}${c2}${modulo10(c2)}${c3}${modulo10(c3)}${codigo[4]}${codigo.slice(5, 19)}`
  return { codigoBarras: codigo, linha }
}

// ------------------------------------------------------------------ Código de arrecadação

/** Linha de 48 dígitos (começa com 8) → código de 44, se os DVs dos 4 blocos e o DV geral baterem. */
export function lerLinhaArrecadacao(linha: string): CodigoLido | null {
  const l = soDigitos(linha)
  if (l.length !== 48 || l[0] !== '8') return null
  const identificador = l[2]
  if (!'6789'.includes(identificador)) return null
  const dv = dvArrecadacao(identificador)
  let codigo = ''
  for (let i = 0; i < 4; i++) {
    const bloco = l.slice(i * 12, i * 12 + 11)
    if (dv(bloco) !== Number(l[i * 12 + 11])) return null
    codigo += bloco
  }
  if (dv(codigo.slice(0, 3) + codigo.slice(4)) !== Number(codigo[3])) return null
  const valorEfetivo = identificador === '6' || identificador === '8'
  const valor = Number(codigo.slice(4, 15))
  return { tipo: 'arrecadacao', linha: l, codigoBarras: codigo, valorCentavos: valorEfetivo && valor > 0 ? valor : null, segmento: codigo[1] }
}

/** Código de arrecadação sintético: segmento (5 = órgãos governamentais), identificador 6 (mód. 10) ou 8 (mód. 11). */
export function montarArrecadacao(opcoes: { valorCentavos: number; segmento?: string; identificador?: '6' | '8'; empresa?: string; livre?: string }): {
  codigoBarras: string
  linha: string
} {
  const segmento = opcoes.segmento ?? '5'
  const identificador = opcoes.identificador ?? '8'
  const empresa = (opcoes.empresa ?? '0328').padStart(4, '0').slice(0, 4)
  const livre = (opcoes.livre ?? '2026112007201234567890').padStart(25, '0').slice(-25)
  const valor = String(opcoes.valorCentavos).padStart(11, '0')
  const semDv = `8${segmento}${identificador}${valor}${empresa}${livre}`
  const dv = dvArrecadacao(identificador)
  const codigo = `8${segmento}${identificador}${dv(semDv)}${valor}${empresa}${livre}`
  let linha = ''
  for (let i = 0; i < 4; i++) {
    const bloco = codigo.slice(i * 11, i * 11 + 11)
    linha += bloco + dv(bloco)
  }
  return { codigoBarras: codigo, linha }
}

/** "8589000001-2 3456…" ou "23793.38128 …" → o código lido, ou null se nenhum formato bater com os DVs. */
export function lerLinha(texto: string, referencia?: Date): CodigoLido | null {
  const d = soDigitos(texto)
  if (d.length === 48) return lerLinhaArrecadacao(d)
  if (d.length === 47) return lerLinhaBoleto(d, referencia)
  return null
}

/** Linha digitável impressa como na guia: arrecadação em 4 blocos "XXXXXXXXXXX-D", boleto nos 5 campos. */
export function formatarLinha(linha: string): string {
  const l = soDigitos(linha)
  if (l.length === 48) return [0, 1, 2, 3].map((i) => `${l.slice(i * 12, i * 12 + 11)}-${l[i * 12 + 11]}`).join(' ')
  if (l.length === 47) {
    return `${l.slice(0, 5)}.${l.slice(5, 10)} ${l.slice(10, 15)}.${l.slice(15, 21)} ${l.slice(21, 26)}.${l.slice(26, 32)} ${l[32]} ${l.slice(33)}`
  }
  return l
}
