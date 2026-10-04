import { randomUUID } from 'node:crypto'
import type { Database } from './database.ts'
import { databaseUrl } from './database.ts'

/** DDL stays in the store. Identifiers are generated here, never taken from a kit. */
export async function createVerificationDatabase(database: Database) {
  const name = `verify_${randomUUID().replaceAll('-', '')}`
  const url = new URL(databaseUrl(database))
  url.pathname = `/${name}`
  // A socket connection can supply dbname in its query string.
  url.searchParams.delete('database')
  await database.query(`CREATE DATABASE ${name} TEMPLATE template0`)
  return {
    url: url.href,
    async drop() {
      await database.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    },
  }
}
