import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { BUILT_IN_WORKFLOWS, loadLibrary } from '../src/library/library.ts'
import { type Database, openDatabase } from '../src/store/database.ts'
import { listMigrations, migrate } from '../src/store/migrate.ts'
import { recordWorkflowVersions } from '../src/store/workflows.ts'
import { createTestDatabase, type TestDatabase } from './helpers/database.ts'

let testDatabase: TestDatabase
let database: Database

before(async () => {
  testDatabase = await createTestDatabase()
  database = openDatabase(testDatabase.url)
})

after(async () => {
  await database.end()
  await testDatabase.drop()
})

describe('store', () => {
  test('migrations apply once', async () => {
    assert.deepEqual(
      await migrate(database),
      (await listMigrations()).map((item) => item.version),
    )
    assert.deepEqual(await migrate(database), [])
  })

  test('concurrent migrations apply each version exactly once', async () => {
    const fresh = await createTestDatabase()
    const first = openDatabase(fresh.url)
    const second = openDatabase(fresh.url)
    try {
      const results = await Promise.all([migrate(first), migrate(second)])
      assert.deepEqual(results.map((applied) => applied.length).sort(), [
        0,
        (await listMigrations()).length,
      ])
    } finally {
      await Promise.all([first.end(), second.end()])
      await fresh.drop()
    }
  })

  test('an idle connection closed by the server does not crash the process', async () => {
    const pool = openDatabase(testDatabase.url)
    try {
      const { rows } = await pool.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      )
      const removed = new Promise((resolve) => pool.once('remove', resolve))
      await database.query('SELECT pg_terminate_backend($1)', [rows[0]!.pid])
      await removed
      assert.equal((await pool.query('SELECT 1 AS one')).rows[0].one, 1)
    } finally {
      await pool.end()
    }
  })

  test('workflow versions are recorded once', async () => {
    const loaded = await loadLibrary(BUILT_IN_WORKFLOWS)
    assert.ok(loaded.ok)
    await recordWorkflowVersions(database, loaded.library)
    await recordWorkflowVersions(database, loaded.library)
    const { rows } = await database.query<{ name: string; version: string }>(
      'SELECT name, version FROM workflow_versions ORDER BY name',
    )
    assert.deepEqual(
      rows,
      [...loaded.library.values()]
        .map(({ workflow, version }) => ({ name: workflow.name, version }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    )
  })
})
