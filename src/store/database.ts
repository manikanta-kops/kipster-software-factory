import { Pool, type PoolClient } from 'pg'

export type Database = Pool
export type Connection = PoolClient

export function openDatabase(connectionString: string): Database {
  return new Pool({ connectionString, max: 10 })
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
