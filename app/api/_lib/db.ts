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

let shared: { db: Db; pool: pg.Pool } | undefined

export function dbFromEnv(): Db {
  if (!shared) {
    const connectionString = process.env.NOFISCAL_DATABASE_URL
    if (!connectionString) throw new Error('NOFISCAL_DATABASE_URL não configurada')
    const pool = new pg.Pool({ connectionString, max: 1 })
    shared = { db: createDb(pool), pool }
  }
  return shared.db
}

export async function closeSharedDb(): Promise<void> {
  if (!shared) return
  const { pool } = shared
  shared = undefined
  await pool.end()
}
