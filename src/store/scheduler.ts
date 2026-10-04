import type { Database } from './database.ts'

const SCHEDULER_LOCK = 4_710_273

/** The connection must stay alive until all work stops; never return it to the pool. */
export async function acquireSchedulerLock(
  database: Database,
  lost: (error: Error) => void,
) {
  const connection = await database.connect()
  connection.on('error', lost)
  try {
    const { rows } = await connection.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [SCHEDULER_LOCK],
    )
    if (!rows[0]?.locked)
      throw new Error(
        'Another factory process holds the scheduler lock for this database; refusing to start scheduler.',
      )
  } catch (error) {
    connection.release(true)
    throw error
  }
  return {
    close() {
      connection.release(true)
    },
  }
}
