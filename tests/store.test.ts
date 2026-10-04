import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { BUILT_IN_WORKFLOWS, loadLibrary } from '../src/library/library.ts'
import { type Database, openDatabase } from '../src/store/database.ts'
import { migrate } from '../src/store/migrate.ts'
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
    assert.deepEqual(await migrate(database), [1, 2, 3, 4, 5])
    assert.deepEqual(await migrate(database), [])
  })

  test('concurrent migrations apply each version exactly once', async () => {
    const fresh = await createTestDatabase()
    const first = openDatabase(fresh.url)
    const second = openDatabase(fresh.url)
    try {
      const results = await Promise.all([migrate(first), migrate(second)])
      assert.deepEqual(results.map((applied) => applied.length).sort(), [0, 5])
    } finally {
      await Promise.all([first.end(), second.end()])
      await fresh.drop()
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
