import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { createApp } from '../src/api/app.ts'
import type {
  ErrorResponse,
  TicketResponse,
  WorkflowResponse,
  WorkflowsResponse,
} from '../src/api/contract.ts'
import { addUploads } from '../src/library/library.ts'
import { startFactory } from '../src/server.ts'
import { type EventSignal, listenForEvents } from '../src/store/events.ts'
import {
  createRepository,
  markRepositoryReady,
} from '../src/store/repositories.ts'
import { listUploadedWorkflows } from '../src/store/workflows.ts'
import {
  builtInLibrary,
  createTestStore,
  type TestStore,
} from './helpers/store.ts'

const reviewOnly = (description = 'Build it and have it reviewed.') => `
name: review-only
description: ${description}
steps:
  - id: build
    kind: agent
    role: builder
  - id: review
    kind: agent
    role: reviewer
    limit: 2
    routes:
      changes-needed: build
`

let store: TestStore
let events: EventSignal
let home: string
let app: ReturnType<typeof createApp>

before(async () => {
  store = await createTestStore()
  events = listenForEvents(store.database)
  await events.ready
  home = await mkdtemp(join(tmpdir(), 'ksf-upload-'))
  app = createApp({
    database: store.database,
    library: await builtInLibrary(),
    events,
    home,
  })
  const repository = await createRepository(store.database, {
    slug: 'acme/shop',
  })
  await markRepositoryReady(store.database, repository.id)
})

after(async () => {
  await events.close()
  await store.close()
  await rm(home, { recursive: true, force: true })
})

function upload(source: unknown, contentType = 'application/json') {
  return app.request('/api/workflows', {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: JSON.stringify({ source }),
  })
}

async function json<T>(response: Response, status: number): Promise<T> {
  const text = await response.text()
  assert.equal(response.status, status, text)
  return JSON.parse(text) as T
}

async function workflows() {
  return (
    await json<WorkflowsResponse>(await app.request('/api/workflows'), 200)
  ).workflows
}

describe('uploading a workflow', () => {
  test('adds it to the library, ready for new tickets', async () => {
    const { workflow } = await json<WorkflowResponse>(
      await upload(reviewOnly()),
      201,
    )
    assert.equal(workflow.name, 'review-only')
    assert.equal(workflow.origin, 'upload')
    assert.deepEqual(
      workflow.steps.map((step) => step.id),
      ['build', 'review'],
    )
    const listed = await workflows()
    assert.equal(listed.find((w) => w.name === 'feature')?.origin, 'file')
    assert.deepEqual(
      listed.find((w) => w.name === 'review-only'),
      workflow,
    )

    const created = await json<TicketResponse>(
      await app.request('/api/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repository: 'acme/shop',
          workflow: 'review-only',
          title: 'Rename the checkout button',
        }),
      }),
      201,
    )
    assert.equal(created.workflow.version, workflow.version)
  })

  test('a new upload is a new version; running tickets keep theirs', async () => {
    const previous = (await workflows()).find((w) => w.name === 'review-only')
    assert.ok(previous)
    const { workflow } = await json<WorkflowResponse>(
      await upload(reviewOnly('Build it, then a reviewer reads the diff.')),
      200,
    )
    assert.notEqual(workflow.version, previous.version)
    const ticket = await json<TicketResponse>(
      await app.request('/api/tickets/1'),
      200,
    )
    assert.equal(ticket.workflow.version, previous.version)
  })

  test('reports every validation error', async () => {
    const problem = await json<ErrorResponse>(
      await upload(`
name: broken
description: Routes to nowhere.
steps:
  - id: build
    kind: agent
    role: coder
  - id: test
    kind: agent
    role: tester
    routes:
      failed: build
      changes-needed: deploy
`),
      400,
    )
    assert.equal(problem.error, 'The workflow is not valid')
    assert.deepEqual(problem.issues, [
      'step "build": role must be one of planner, builder, tester, reproducer, reviewer, writer, onboarder, lead',
      'step "test": cannot route "failed"; this step can report passed, changes-needed, needs-decision',
      'step "test": route "changes-needed" goes to unknown step "deploy" (exits: finish, cancel, ask)',
    ])
    assert.ok(!(await workflows()).some((w) => w.name === 'broken'))
  })

  test('rejects YAML that does not parse', async () => {
    const problem = await json<ErrorResponse>(
      await upload('name: [unclosed'),
      400,
    )
    assert.match(problem.issues?.[0] ?? '', /^not valid YAML/)
  })

  test('cannot replace a workflow file', async () => {
    const feature = (await workflows()).find((w) => w.name === 'feature')
    const problem = await json<ErrorResponse>(
      await upload(reviewOnly().replace('review-only', 'feature')),
      409,
    )
    assert.match(problem.error, /"feature" is a workflow file/)
    assert.deepEqual(
      (await workflows()).find((w) => w.name === 'feature'),
      feature,
    )
  })

  test('accepts only a JSON body with source text', async () => {
    assert.match(
      (await json<ErrorResponse>(await upload(reviewOnly(), 'text/plain'), 400))
        .error,
      /as JSON/,
    )
    await json<ErrorResponse>(await upload(42), 400)
    await json<ErrorResponse>(await upload('x'.repeat(100_001)), 400)
  })
})

describe('saved uploads', () => {
  test('a file with the same name wins and a now-invalid upload is left out', async () => {
    const library = await builtInLibrary()
    const warnings = addUploads(library, [
      { name: 'feature', source: reviewOnly() },
      { name: 'stale', source: 'name: stale\ndescription: Old.\nsteps: []' },
      { name: 'review-only', source: reviewOnly() },
    ])
    assert.equal(warnings.length, 2)
    assert.match(warnings[0] ?? '', /"feature" is hidden by the workflow file/)
    assert.match(warnings[1] ?? '', /"stale" is no longer valid/)
    assert.equal(library.get('feature')?.uploaded, undefined)
    assert.equal(library.get('review-only')?.uploaded, true)
    assert.ok(!library.has('stale'))
  })

  test('survive a factory restart', async () => {
    const factoryHome = await mkdtemp(join(tmpdir(), 'ksf-upload-home-'))
    const restartStore = await createTestStore()
    try {
      const start = async () =>
        startFactory({
          databaseUrl: restartStore.url,
          port: await freePort(),
          scheduler: false,
          home: factoryHome,
        })
      let factory = await start()
      try {
        const response = await fetch(`${factory.url}/api/workflows`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: reviewOnly() }),
        })
        assert.equal(response.status, 201, await response.text())
      } finally {
        await factory.close()
      }

      factory = await start()
      try {
        const { workflows: listed } = (await (
          await fetch(`${factory.url}/api/workflows`)
        ).json()) as WorkflowsResponse
        assert.equal(
          listed.find((w) => w.name === 'review-only')?.origin,
          'upload',
        )
      } finally {
        await factory.close()
      }
      assert.deepEqual(
        (await listUploadedWorkflows(restartStore.database)).map((w) => w.name),
        ['review-only'],
      )
    } finally {
      await restartStore.close()
      await rm(factoryHome, { recursive: true, force: true })
    }
  })
})

async function freePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}
