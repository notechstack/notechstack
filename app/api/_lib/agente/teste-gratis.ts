// Bloqueio de novo teste grátis (critério 14 e Decided "Bloqueio de novo teste"):
// `fiscal_trial_claims.hash` = sha256(sal + valor normalizado), em hex, sem separador, como
// o `DIAG_IP_SALT` do diagnóstico do auditor. O sal vem de `FISCAL_TRIAL_SALT`; sem ele,
// recusa. O valor em claro nunca sai daqui.
import { createHash } from 'node:crypto'
import { normalizarDocumento, normalizarEmail, normalizarTelefone } from './normalizacao.js'

export type TipoDoTeste = 'cpf' | 'cnpj' | 'email' | 'phone'

export class ValorDoTesteInvalido extends Error {
  constructor(readonly tipo: TipoDoTeste) {
    super(`valor inválido para ${tipo}`)
    this.name = 'ValorDoTesteInvalido'
  }
}

export function normalizarParaTeste(tipo: TipoDoTeste, valor: string): string {
  const normalizado =
    tipo === 'cpf'
      ? normalizarDocumento(valor, 11)
      : tipo === 'cnpj'
        ? normalizarDocumento(valor, 14)
        : tipo === 'email'
          ? normalizarEmail(valor)
          : normalizarTelefone(valor)
  if (normalizado === null) throw new ValorDoTesteInvalido(tipo)
  return normalizado
}

export function hashDoTeste(tipo: TipoDoTeste, valor: string, sal: string | undefined = process.env.FISCAL_TRIAL_SALT): string {
  if (!sal) throw new Error('FISCAL_TRIAL_SALT não configurado')
  return createHash('sha256').update(sal + normalizarParaTeste(tipo, valor), 'utf8').digest('hex')
}

export type ValoresDoTeste = { cpf?: string; cnpj: string; email: string; phone: string }

/** O objeto `p_hashes` de `public.fiscal_reivindicar_teste`. */
export function hashesDoTeste(
  valores: ValoresDoTeste,
  sal: string | undefined = process.env.FISCAL_TRIAL_SALT,
): Partial<Record<TipoDoTeste, string>> {
  const hashes: Partial<Record<TipoDoTeste, string>> = {}
  for (const tipo of ['cpf', 'cnpj', 'email', 'phone'] as const) {
    const valor = valores[tipo]
    if (valor !== undefined) hashes[tipo] = hashDoTeste(tipo, valor, sal)
  }
  return hashes
}
