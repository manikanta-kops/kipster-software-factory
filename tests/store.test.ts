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

test('lights-out migration preserves existing lead tickets as off and keeps old artifacts readable', async () => {
  const { mkdtemp, copyFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { getTicketDetail } = await import('../src/store/tickets.ts')
  const fresh = await createTestDatabase()
  const db = openDatabase(fresh.url)
  const directory = await mkdtemp(join(tmpdir(), 'lights-out-migrations-'))
  try {
    const migrations = await listMigrations()
    for (const migration of migrations.filter((item) => item.version < 14)) {
      await copyFile(
        migration.file,
        join(
          directory,
          `${String(migration.version).padStart(3, '0')}_${migration.name}.sql`,
        ),
      )
    }
    await migrate(db, directory)
    const loaded = await loadLibrary(BUILT_IN_WORKFLOWS)
    assert.ok(loaded.ok)
    await recordWorkflowVersions(db, loaded.library)
    const version = loaded.library.get('lead')!.version
    const repo = await db.query<{ id: number }>(
      "INSERT INTO repositories (slug, clone_url, default_branch, status) VALUES ('upgrade/app', 'unused', 'main', 'ready') RETURNING id",
    )
    const ticket = await db.query<{ id: number }>(
      `INSERT INTO tickets (number, repository_id, workflow_name, workflow_version, title, branch, current_step, status, skipped_steps) VALUES (1, $1, 'lead', $2, 'Existing lead', 'kipster/1', 'lead', 'queued', $3) RETURNING id`,
      [
        repo.rows[0]!.id,
        version,
        JSON.stringify([{ stepId: 'test', missingCapabilities: ['verify'] }]),
      ],
    )
    const attempt = await db.query<{ id: number }>(
      "INSERT INTO attempts (ticket_id, step_id, status) VALUES ($1, 'lead', 'pending') RETURNING id",
      [ticket.rows[0]!.id],
    )
    await db.query(
      "INSERT INTO artifacts (ticket_id, attempt_id, kind, title, content) VALUES ($1, $2, 'note', 'Old note', 'Still readable')",
      [ticket.rows[0]!.id, attempt.rows[0]!.id],
    )
    assert.deepEqual(await migrate(db), [14, 15, 16])
    const detail = await getTicketDetail(db, 1)
    assert.equal(detail!.ticket.summary, null)
    assert.equal(detail!.ticket.lightsOut, false)
    assert.deepEqual(detail!.ticket.skippedSteps, [
      { stepId: 'test', missingCapabilities: ['verify'] },
    ])
    assert.equal(detail!.artifacts[0]!.content, 'Still readable')
    assert.equal(detail!.artifacts[0]!.decision, null)
  } finally {
    await db.end()
    await fresh.drop()
    await rm(directory, { recursive: true, force: true })
  }
})
