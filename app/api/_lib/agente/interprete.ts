// Intérprete por IA (Decided "IA sem poder de emitir"; Landing, lote B - intérprete). A IA só
// devolve a saída estruturada abaixo, que vai para `fiscal_requests.parsed`; emitir e cancelar
// acontecem só no código da conversa, depois do "confirmar". Com `ANTHROPIC_API_KEY`, a v2 usa
// `interpreteClaude` (interprete-claude.ts); sem ela, vale `interpreteNaoConfigurado()`.
import { cnpjValido, cpfValido } from './documentos.js'

export type Intencao = 'emitir' | 'cancelar' | 'outro'

export type Parsed = {
  tomador: string | null
  documento: string | null
  valor: string | null
  modelo: string | null
  intencao: Intencao
}

export type Interpretacao = { parsed: Parsed; tokens: { entrada: number; saida: number } }

export interface Interprete {
  interpretar(texto: string): Promise<Interpretacao>
}

const VALOR = /^(\d{1,12})(?:\.(\d{1,2}))?$/

function texto(valor: unknown, max: number): string | null {
  if (typeof valor !== 'string') return null
  const limpo = valor.trim().replace(/\s+/g, ' ')
  return limpo.length >= 1 && limpo.length <= max ? limpo : null
}

/** Valor decimal positivo com 2 casas (`"10.00"`), ou `null`. */
export function valorValido(valor: unknown): string | null {
  const bruto = typeof valor === 'number' && Number.isFinite(valor) ? String(valor) : valor
  if (typeof bruto !== 'string') return null
  const m = VALOR.exec(bruto.trim())
  if (!m) return null
  const normalizado = `${BigInt(m[1])}.${(m[2] ?? '').padEnd(2, '0')}`
  return normalizado === '0.00' ? null : normalizado
}

/**
 * Revalida a saída da IA: só os cinco campos, cada um no formato que o código aceita. Campo
 * a mais é descartado; campo inválido vira `null` (e a conversa pergunta o que falta).
 */
export function validarParsed(bruto: unknown): Parsed {
  const obj = typeof bruto === 'object' && bruto !== null && !Array.isArray(bruto) ? (bruto as Record<string, unknown>) : {}
  const digitos = typeof obj.documento === 'string' ? obj.documento.replace(/\D/g, '') : ''
  const documento = (digitos.length === 11 && cpfValido(digitos)) || (digitos.length === 14 && cnpjValido(digitos)) ? digitos : null
  const intencao: Intencao = obj.intencao === 'emitir' || obj.intencao === 'cancelar' ? obj.intencao : 'outro'
  return {
    tomador: texto(obj.tomador, 150),
    documento,
    valor: valorValido(obj.valor),
    modelo: texto(obj.modelo, 60),
    intencao,
  }
}

export class InterpreteNaoConfigurado extends Error {
  constructor() {
    super('INTERPRETE_NAO_CONFIGURADO')
    this.name = 'InterpreteNaoConfigurado'
  }
}

/** Até o spike 3 escolher o modelo (Unresolved 7), nenhuma IA é chamada. */
export function interpreteNaoConfigurado(): Interprete {
  return {
    async interpretar() {
      throw new InterpreteNaoConfigurado()
    },
  }
}
