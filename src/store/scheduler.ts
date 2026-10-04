import type { Database } from './database.ts'

const SCHEDULER_LOCK = 4_710_273

/** The connection must stay alive until all work stops; never return it to the pool. */
export async function acquireSchedulerLock(
  database: Database,
  lost: (error: Error) => void,
  purpose: 'scheduler' | 'demo' = 'scheduler',
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
    const { rows: mode } = await connection.query<{ demo: boolean }>(
      'SELECT demo FROM factory_mode',
    )
    if (purpose === 'scheduler' && mode[0]?.demo)
      throw new Error(
        'Demo data cannot run with a scheduler; use --no-scheduler.',
      )
    if (purpose === 'demo') {
      const { rows: repositories } = await connection.query(
        'SELECT 1 FROM repositories LIMIT 1',
      )
      if (repositories.length)
        throw new Error(
          'Demo seeding requires an empty database (or already has demo data).',
        )
      await connection.query('UPDATE factory_mode SET demo = true')
    }
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
