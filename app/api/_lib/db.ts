// Acesso ao banco da Nó: só pelo papel `nofiscal_service`, por conexão Postgres direta
// (pooler do Supabase em modo transação), nunca pela service role (critério 33).
// Forma literal no Landing do checklist: driver `pg`, `NOFISCAL_DATABASE_URL`, `max: 1`,
// e só consultas parametrizadas sem nome (o pooler em modo transação não aceita
// prepared statement nomeado).
import pg from 'pg'

export type QueryResult<R> = { rows: R[]; rowCount: number }

export interface Queryable {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<R>>
}

export interface Db extends Queryable {
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>
}

function wrap(client: { query: (text: string, values?: unknown[]) => Promise<pg.QueryResult> }): Queryable {
  return {
    async query<R>(text: string, values?: unknown[]) {
      const result = await client.query(text, values)
      return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 }
    },
  }
}

export function createDb(pool: pg.Pool): Db {
  const base = wrap(pool)
  return {
    query: base.query,
    async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect()
      try {
        await client.query('begin')
        const result = await work(wrap(client))
        await client.query('commit')
        return result
      } catch (error) {
        await client.query('rollback').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },
  }
}

// Uma conexão por papel: `NOFISCAL_DATABASE_URL` (motor, `nofiscal_service`) e
// `NOFISCAL_ONBOARDING_DATABASE_URL` (rota do certificado, `nofiscal_onboarding`; Landing
// de .checks/agente-fiscal-whatsapp.md, lote A).
export type DbUrlVariable = 'NOFISCAL_DATABASE_URL' | 'NOFISCAL_ONBOARDING_DATABASE_URL'

const shared = new Map<DbUrlVariable, { db: Db; pool: pg.Pool }>()

export function dbFromEnv(variable: DbUrlVariable = 'NOFISCAL_DATABASE_URL'): Db {
  let entry = shared.get(variable)
  if (!entry) {
    const connectionString = process.env[variable]
    if (!connectionString) throw new Error(`${variable} não configurada`)
    const pool = new pg.Pool({ connectionString, max: 1 })
    entry = { db: createDb(pool), pool }
    shared.set(variable, entry)
  }
  return entry.db
}

export async function closeSharedDb(): Promise<void> {
  const pools = [...shared.values()].map((entry) => entry.pool)
  shared.clear()
  await Promise.all(pools.map((pool) => pool.end()))
}
