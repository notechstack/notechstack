// Numeração da DPS (critério 9): `nofiscal.allocate_dps_number` faz `UPDATE … RETURNING`
// na linha da série, que fica travada até o fim da transação de quem chamou. Duas emissões
// simultâneas recebem números distintos. O destino do número de uma DPS rejeitada
// (reusar ou pular) segue em aberto: Unresolved 1 da tarefa.
import type { Queryable } from './db.js'

export class SerieNotFoundError extends Error {
  readonly code = 'NOFISCAL_SERIE_NOT_FOUND'
  constructor() {
    super('NOFISCAL_SERIE_NOT_FOUND')
    this.name = 'SerieNotFoundError'
  }
}

/** Chame dentro da transação da emissão: o número só vale se ela confirmar. */
export async function allocateDpsNumber(tx: Queryable, tenantId: string, serie: string): Promise<number> {
  try {
    const { rows } = await tx.query<{ numero: string }>('select nofiscal.allocate_dps_number($1, $2) as numero', [
      tenantId,
      serie,
    ])
    return Number(rows[0].numero)
  } catch (error) {
    if (error instanceof Error && error.message.includes('NOFISCAL_SERIE_NOT_FOUND')) throw new SerieNotFoundError()
    throw error
  }
}
