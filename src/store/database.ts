import { Pool, type PoolClient } from 'pg'

export type Database = Pool
export type Connection = PoolClient
/** A pool or a connection inside a transaction. */
export type Queryable = Pick<Connection, 'query'>

const urls = new WeakMap<Database, string>()
export function databaseUrl(database: Database): string {
  const url = urls.get(database)
  if (!url) throw new Error('Database must be opened with openDatabase')
  return url
}

export function openDatabase(connectionString: string): Database {
  const pool = new Pool({ connectionString, max: 10 })
  urls.set(pool, connectionString)
  return pool
}

export async function transaction<T>(
  database: Database,
  work: (connection: Connection) => Promise<T>,
): Promise<T> {
  const connection = await database.connect()
  try {
    await connection.query('BEGIN')
    const result = await work(connection)
    await connection.query('COMMIT')
    return result
  } catch (error) {
    await connection.query('ROLLBACK')
    throw error
  } finally {
    connection.release()
  }
}
