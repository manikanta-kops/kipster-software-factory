import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Database, transaction } from './database.ts'

const MIGRATIONS = fileURLToPath(new URL('./migrations/', import.meta.url))

// Arbitrary constant so concurrent factory processes never migrate at the same time.
const MIGRATION_LOCK = 4_710_271

interface Migration {
  readonly version: number
  readonly name: string
  readonly file: string
}

export async function listMigrations(
  directory = MIGRATIONS,
): Promise<Migration[]> {
  const migrations: Migration[] = []
  for (const file of (await readdir(directory)).sort()) {
    const match = /^(\d{3})_([a-z0-9_]+)\.sql$/.exec(file)
    if (!match) throw new Error(`Unexpected file in migrations: ${file}`)
    migrations.push({
      version: Number(match[1]),
      name: match[2] as string,
      file: join(directory, file),
    })
  }
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `Migrations must be numbered 001, 002, … without gaps; found ${migration.file}`,
      )
    }
  })
  return migrations
}

/** Applies pending migrations in one transaction and returns the versions applied. */
export async function migrate(
  database: Database,
  directory = MIGRATIONS,
): Promise<number[]> {
  const migrations = await listMigrations(directory)
  return transaction(database, async (connection) => {
    await connection.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK])
    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`)
    const { rows } = await connection.query<{ version: number }>(
      'SELECT version FROM schema_migrations',
    )
    const applied = new Set(rows.map((row) => row.version))
    const newlyApplied: number[] = []
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue
      await connection.query(await readFile(migration.file, 'utf8'))
      await connection.query(
        'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
        [migration.version, migration.name],
      )
      newlyApplied.push(migration.version)
    }
    return newlyApplied
  })
}
