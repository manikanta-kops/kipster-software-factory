import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { HealthResponse, WorkflowsResponse } from '../src/api/contract.ts'
import { createApp } from '../src/api/app.ts'
import { BUILT_IN_WORKFLOWS, loadLibrary } from '../src/library/library.ts'
import { type Database, openDatabase } from '../src/store/database.ts'
import { createTestDatabase, type TestDatabase } from './helpers/database.ts'

let testDatabase: TestDatabase
let database: Database
let app: ReturnType<typeof createApp>

before(async () => {
  testDatabase = await createTestDatabase()
  database = openDatabase(testDatabase.url)
  const loaded = await loadLibrary(BUILT_IN_WORKFLOWS)
  assert.ok(loaded.ok)
  app = createApp({ database, library: loaded.library })
})

after(async () => {
  await database.end()
  await testDatabase.drop()
})

describe('api', () => {
  test('reports health after reaching the database', async () => {
    const response = await app.request('/api/health')
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()) as HealthResponse, {
      status: 'ok',
      database: 'ok',
    })
  })

  test('describes each workflow with resolved routes', async () => {
    const response = await app.request('/api/workflows')
    assert.equal(response.status, 200)
    const { workflows } = (await response.json()) as WorkflowsResponse
    const feature = workflows.find((workflow) => workflow.name === 'feature')
    assert.ok(feature)
    assert.match(feature.version, /^[0-9a-f]{12}$/)
    const testStep = feature.steps.find((step) => step.id === 'test')
    assert.deepEqual(testStep?.routes.slice(0, 2), [
      { outcome: 'passed', next: { to: 'step', stepId: 'review' } },
      { outcome: 'changes-needed', next: { to: 'step', stepId: 'build' } },
    ])
    assert.equal(testStep?.does, 'tester')
    assert.deepEqual(testStep?.needs, ['verify'])
  })

  test('answers unknown API paths with JSON 404', async () => {
    const response = await app.request('/api/nothing')
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: 'Not found' })
  })
})
