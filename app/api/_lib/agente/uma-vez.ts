// "Uma vez só" (Landing, lote B - mensagem repetida e avisos únicos): quem consegue inserir a
// chave em `nofiscal.fiscal_agent_once` faz a ação; a repetição encontra a chave e não faz nada.
import type { Queryable } from '../db.js'

export async function marcarUmaVez(db: Queryable, chave: string, tenantId: string | null = null): Promise<boolean> {
  const { rowCount } = await db.query(
    'insert into nofiscal.fiscal_agent_once (chave, tenant_id) values ($1, $2) on conflict (chave) do nothing',
    [chave, tenantId],
  )
  return rowCount === 1
}

/** Desfaz a marca de uma mensagem cujo processamento falhou, para a reentrega da Meta valer. */
export async function desmarcar(db: Queryable, chave: string): Promise<void> {
  await db.query('delete from nofiscal.fiscal_agent_once where chave = $1', [chave])
}
