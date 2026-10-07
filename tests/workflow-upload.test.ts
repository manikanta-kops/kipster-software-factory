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
  RemoveWorkflowResponse,
  TicketResponse,
  WorkflowInUseResponse,
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
import { createTicket } from '../src/store/tickets.ts'
import { listUploadedWorkflows } from '../src/store/workflows.ts'
import {
  builtInLibrary,
  builtInWorkflow,
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
    assert.equal(workflow.selectable, true)
    assert.deepEqual(
      workflow.steps.map((step) => step.id),
      ['build', 'review'],
    )
    const listed = await workflows()
    assert.deepEqual(
      listed.filter((item) => item.selectable).map((item) => item.name),
      ['bug', 'lead', 'onboard-repo', 'review-only'],
    )
    assert.deepEqual(
      listed
        .filter((item) => !item.selectable)
        .map((item) => item.name)
        .sort(),
      ['task', 'task-pr'],
    )
    assert.equal(listed.find((w) => w.name === 'lead')?.origin, 'file')
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
    const lead = (await workflows()).find((w) => w.name === 'lead')
    const problem = await json<ErrorResponse>(
      await upload(reviewOnly().replace('review-only', 'lead')),
      409,
    )
    assert.match(problem.error, /"lead" is a workflow file/)
    assert.deepEqual(
      (await workflows()).find((w) => w.name === 'lead'),
      lead,
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
      { name: 'lead', source: reviewOnly() },
      { name: 'stale', source: 'name: stale\ndescription: Old.\nsteps: []' },
      { name: 'review-only', source: reviewOnly() },
    ])
    assert.equal(warnings.length, 2)
    assert.match(warnings[0] ?? '', /"lead" is hidden by the workflow file/)
    assert.match(warnings[1] ?? '', /"stale" is no longer valid/)
    assert.equal(library.get('lead')?.uploaded, undefined)
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

describe('removing an uploaded workflow', () => {
  const remove = (name: string) =>
    app.request(`/api/workflows/${name}`, { method: 'DELETE' })
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  test('refuses a workflow file and an unknown name', async () => {
    const problem = await json<ErrorResponse>(await remove('lead'), 409)
    assert.equal(
      problem.error,
      '"lead" is a workflow file in the factory and cannot be removed; only uploaded workflows can',
    )
    assert.ok((await workflows()).some((w) => w.name === 'lead'))
    assert.equal(
      (await json<ErrorResponse>(await remove('nothing-here'), 404)).error,
      'No uploaded workflow "nothing-here"',
    )
  })

  test('refuses while unfinished tickets or lead tasks use it, listing them', async () => {
    const kitted = await createRepository(store.database, {
      slug: 'acme/kitted',
    })
    await markRepositoryReady(store.database, kitted.id, {
      capabilities: ['verify'],
    })
    const lead = await createTicket(store.database, {
      repository: 'acme/kitted',
      workflow: await builtInWorkflow('lead'),
      title: 'Split the checkout work',
    })
    await store.database.query(
      `INSERT INTO tasks (ticket_id, attempt_id, key, title, instructions, land, workflow)
       SELECT ticket_id, id, 'copy', 'Tidy copy', 'Tidy the copy.', 'branch', 'review-only'
       FROM attempts WHERE ticket_id = $1`,
      [lead.id],
    )
    const problem = await json<WorkflowInUseResponse>(
      await remove('review-only'),
      409,
    )
    assert.deepEqual(problem.tickets, [1, lead.number])
    assert.equal(
      problem.error,
      `"review-only" is used by unfinished tickets #1, #${lead.number}; finish or cancel them first`,
    )
    assert.ok((await workflows()).some((w) => w.name === 'review-only'))

    await json<TicketResponse>(
      await post(`/api/tickets/${lead.number}/cancel`, {}),
      200,
    )
    assert.deepEqual(
      (await json<WorkflowInUseResponse>(await remove('review-only'), 409))
        .tickets,
      [1],
    )
  })

  test('removes it once its tickets finish; they still open', async () => {
    const opened = await json<TicketResponse>(
      await app.request('/api/tickets/1'),
      200,
    )
    await json<TicketResponse>(
      await post('/api/tickets/1/cancel', { reason: 'Not needed' }),
      200,
    )
    assert.deepEqual(
      await json<RemoveWorkflowResponse>(await remove('review-only'), 200),
      { removed: 'review-only' },
    )
    assert.ok(!(await workflows()).some((w) => w.name === 'review-only'))
    assert.deepEqual(await listUploadedWorkflows(store.database), [])

    const reopened = await json<TicketResponse>(
      await app.request('/api/tickets/1'),
      200,
    )
    assert.equal(reopened.ticket.status, 'cancelled')
    assert.deepEqual(reopened.workflow, {
      ...opened.workflow,
      steps: reopened.workflow.steps,
    })
    assert.deepEqual(
      reopened.workflow.steps.map((step) => step.id),
      opened.workflow.steps.map((step) => step.id),
    )

    assert.match(
      (
        await json<ErrorResponse>(
          await post('/api/tickets', {
            repository: 'acme/shop',
            workflow: 'review-only',
            title: 'Too late',
          }),
          400,
        )
      ).error,
      /^No workflow "review-only"/,
    )
    await json<ErrorResponse>(await remove('review-only'), 404)
    await json<WorkflowResponse>(await upload(reviewOnly()), 201)
  })

  test('stays removed after a restart, and its tickets still open', async () => {
    const factoryHome = await mkdtemp(join(tmpdir(), 'ksf-remove-home-'))
    const restartStore = await createTestStore()
    const repository = await createRepository(restartStore.database, {
      slug: 'acme/shop',
    })
    await markRepositoryReady(restartStore.database, repository.id)
    try {
      const start = async () =>
        startFactory({
          databaseUrl: restartStore.url,
          port: await freePort(),
          scheduler: false,
          home: factoryHome,
        })
      const call = (url: string, method: string, body?: unknown) =>
        fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      let factory = await start()
      try {
        await json(
          await call(`${factory.url}/api/workflows`, 'POST', {
            source: reviewOnly(),
          }),
          201,
        )
        const { ticket } = await json<TicketResponse>(
          await call(`${factory.url}/api/tickets`, 'POST', {
            repository: 'acme/shop',
            workflow: 'review-only',
            title: 'Rename the checkout button',
          }),
          201,
        )
        await json(
          await call(
            `${factory.url}/api/tickets/${ticket.number}/cancel`,
            'POST',
            {},
          ),
          200,
        )
        await json(
          await call(`${factory.url}/api/workflows/review-only`, 'DELETE'),
          200,
        )
      } finally {
        await factory.close()
      }

      factory = await start()
      try {
        const { workflows: listed } = await json<WorkflowsResponse>(
          await fetch(`${factory.url}/api/workflows`),
          200,
        )
        assert.ok(!listed.some((w) => w.name === 'review-only'))
        const opened = await json<TicketResponse>(
          await fetch(`${factory.url}/api/tickets/1`),
          200,
        )
        assert.equal(opened.workflow.name, 'review-only')
        assert.deepEqual(
          opened.workflow.steps.map((step) => step.id),
          ['build', 'review'],
        )
      } finally {
        await factory.close()
      }
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
