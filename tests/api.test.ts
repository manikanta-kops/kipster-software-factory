import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { createApp } from '../src/api/app.ts'
import type {
  ErrorResponse,
  EventMessage,
  HealthResponse,
  RepositoriesResponse,
  RepositoryResponse,
  TicketResponse,
  TicketsResponse,
  WorkflowsResponse,
} from '../src/api/contract.ts'
import type { Database } from '../src/store/database.ts'
import { type EventSignal, listenForEvents } from '../src/store/events.ts'
import { markRepositoryReady } from '../src/store/repositories.ts'
import {
  claimAttempts,
  completeAttempt,
  failAttempt,
  markRunning,
} from '../src/store/tickets.ts'
import {
  testLibrary,
  createTestStore,
  type TestStore,
} from './helpers/store.ts'

let store: TestStore
let database: Database
let events: EventSignal
let home: string
let app: ReturnType<typeof createApp>

before(async () => {
  store = await createTestStore()
  database = store.database
  events = listenForEvents(database)
  await events.ready
  home = await mkdtemp(join(tmpdir(), 'ksf-home-'))
  app = createApp({
    database,
    library: await testLibrary(),
    events,
    home,
    allowedOrigins: ['http://localhost:5173', 'tauri://localhost'],
  })
})

after(async () => {
  await events.close()
  await store.close()
  await rm(home, { recursive: true, force: true })
})

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function json<T>(response: Response, status: number): Promise<T> {
  const text = await response.text()
  assert.equal(response.status, status, text)
  return JSON.parse(text) as T
}

async function readyRepository(slug: string) {
  const { repository } = await json<RepositoryResponse>(
    await post('/api/repositories', { slug }),
    201,
  )
  await markRepositoryReady(database, repository.id)
  return repository
}

async function newTicket(repository = 'acme/shop', title = 'Add dark mode') {
  return json<TicketResponse>(
    await post('/api/tickets', {
      repository,
      workflow: 'planned-change',
      title,
      body: 'Make it **dark**.',
    }),
    201,
  )
}

/** Runs the ticket's pending attempt to the given outcome, as the engine would. */
async function runStep(
  number: number,
  outcome: string,
  artifacts: unknown[] = [],
) {
  const claimed = await claimAttempts(database, 100)
  const mine = claimed.find((context) => context.ticket.number === number)
  assert.ok(mine, `ticket #${number} had nothing to claim`)
  await markRunning(database, mine.attempt.id, 'claude-code')
  await completeAttempt(database, mine.attempt.id, {
    outcome,
    summary: `Reported ${outcome}`,
    artifacts,
  })
}

async function ticket(number: number) {
  return json<TicketResponse>(await app.request(`/api/tickets/${number}`), 200)
}

describe('api basics', () => {
  test('reports health after reaching the database', async () => {
    assert.deepEqual(
      await json<HealthResponse>(await app.request('/api/health'), 200),
      { status: 'ok', database: 'ok' },
    )
  })

  test('describes each workflow with resolved routes', async () => {
    const { workflows } = await json<WorkflowsResponse>(
      await app.request('/api/workflows'),
      200,
    )
    const tested = workflows.find(
      (workflow) => workflow.name === 'tested-change',
    )
    assert.ok(tested)
    assert.match(tested.version, /^[0-9a-f]{12}$/)
    const testStep = tested.steps.find((step) => step.id === 'test')
    assert.deepEqual(testStep?.routes.slice(0, 2), [
      { outcome: 'passed', next: { to: 'step', stepId: 'review' } },
      { outcome: 'changes-needed', next: { to: 'step', stepId: 'build' } },
    ])
    assert.equal(testStep?.does, 'tester')
    assert.deepEqual(testStep?.needs, ['verify'])
    assert.ok(workflows.some((workflow) => workflow.name === 'planned-change'))
  })

  test('answers unknown API paths with JSON 404', async () => {
    assert.deepEqual(
      await json<ErrorResponse>(await app.request('/api/nothing'), 404),
      { error: 'Not found' },
    )
    await json<ErrorResponse>(await app.request('/api/tickets/abc'), 404)
  })
})

describe('cors', () => {
  test('allows only listed origins', async () => {
    const allowed = await app.request('/api/health', {
      headers: { Origin: 'tauri://localhost' },
    })
    assert.equal(
      allowed.headers.get('Access-Control-Allow-Origin'),
      'tauri://localhost',
    )
    const denied = await app.request('/api/health', {
      headers: { Origin: 'https://evil.example' },
    })
    assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null)
  })

  test('answers preflight requests for JSON posts', async () => {
    const response = await app.request('/api/tickets', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    })
    assert.equal(response.status, 204)
    assert.equal(
      response.headers.get('Access-Control-Allow-Origin'),
      'http://localhost:5173',
    )
    assert.match(
      response.headers.get('Access-Control-Allow-Methods') ?? '',
      /POST/,
    )
  })
})

describe('repositories', () => {
  test('are registered and listed', async () => {
    const { repository } = await json<RepositoryResponse>(
      await post('/api/repositories', {
        slug: 'acme/listed',
        defaultBranch: 'trunk',
      }),
      201,
    )
    assert.equal(repository.status, 'pending')
    assert.equal(repository.defaultBranch, 'trunk')
    const { repositories } = await json<RepositoriesResponse>(
      await app.request('/api/repositories'),
      200,
    )
    assert.ok(
      repositories.some((candidate) => candidate.slug === 'acme/listed'),
    )
  })

  test('reject invalid and duplicate slugs', async () => {
    const invalid = await json<ErrorResponse>(
      await post('/api/repositories', { slug: 'not a slug' }),
      400,
    )
    assert.deepEqual(invalid, {
      error: 'Invalid request',
      issues: ['slug: use owner/name'],
    })
    await post('/api/repositories', { slug: 'acme/twice' })
    assert.match(
      (
        await json<ErrorResponse>(
          await post('/api/repositories', { slug: 'acme/TWICE' }),
          409,
        )
      ).error,
      /already registered/,
    )
    const unknown = await json<ErrorResponse>(
      await post('/api/repositories', { slug: 'acme/x', private: true }),
      400,
    )
    assert.match(unknown.issues?.join() ?? '', /private/)
  })
})

describe('tickets', () => {
  test('API creation still accepts the lead-only task workflows', async () => {
    const repository = await readyRepository('acme/lead-tasks')
    await markRepositoryReady(database, repository.id, {
      capabilities: ['verify'],
    })
    for (const name of ['task', 'task-pr']) {
      const created = await json<TicketResponse>(
        await post('/api/tickets', {
          repository: repository.slug,
          workflow: name,
          title: `Create ${name}`,
        }),
        201,
      )
      assert.equal(created.workflow.name, name)
      assert.equal(created.ticket.currentStep, 'build')
    }
  })

  before(() => readyRepository('acme/shop'))

  test('are created on the first step with the workflow and its run counts', async () => {
    const created = await newTicket()
    assert.equal(created.ticket.status, 'queued')
    assert.equal(created.ticket.body, 'Make it **dark**.')
    assert.equal(created.workflow.name, 'planned-change')
    assert.deepEqual(
      created.workflow.steps.map((step) => [step.id, step.runs]),
      [
        ['plan', 0],
        ['approve-plan', 0],
        ['build', 0],
        ['review', 0],
        ['maintain-pr', 0],
        ['merge', 0],
      ],
    )
    assert.equal(created.workflow.steps[3]?.limit, 2)
    assert.deepEqual(
      created.attempts.map((attempt) => [attempt.stepId, attempt.status]),
      [['plan', 'pending']],
    )
    assert.deepEqual(
      created.events.map((event) => event.kind),
      ['ticket.created', 'attempt.queued'],
    )
  })

  test('validate their input', async () => {
    assert.deepEqual(
      await json<ErrorResponse>(await post('/api/tickets', '{nope'), 400),
      { error: 'The request body must be JSON' },
    )
    const missing = await json<ErrorResponse>(
      await post('/api/tickets', {
        repository: 'acme/shop',
        workflow: 'planned-change',
      }),
      400,
    )
    assert.match(missing.issues?.join() ?? '', /title/)
    assert.match(
      (
        await json<ErrorResponse>(
          await post('/api/tickets', {
            repository: 'acme/shop',
            workflow: 'deploy',
            title: 'x',
          }),
          400,
        )
      ).error,
      /No workflow "deploy"; choose one of .*planned-change/,
    )
    assert.match(
      (
        await json<ErrorResponse>(
          await post('/api/tickets', {
            repository: 'acme/nowhere',
            workflow: 'planned-change',
            title: 'x',
          }),
          400,
        )
      ).error,
      /No repository acme\/nowhere/,
    )
  })

  test('are rejected when the repository lacks capabilities or is not ready', async () => {
    const tested = await json<ErrorResponse>(
      await post('/api/tickets', {
        repository: 'acme/shop',
        workflow: 'tested-change',
        title: 'x',
      }),
      400,
    )
    assert.match(
      tested.error,
      /Workflow "tested-change" needs capabilities that acme\/shop does not provide: verify \(needed by test\)/,
    )
    await post('/api/repositories', { slug: 'acme/cloning' })
    await json<ErrorResponse>(
      await post('/api/tickets', {
        repository: 'acme/cloning',
        workflow: 'planned-change',
        title: 'x',
      }),
      409,
    )
  })

  test('are listed by status', async () => {
    const { ticket: created } = await newTicket('acme/shop', 'Listed')
    const { tickets } = await json<TicketsResponse>(
      await app.request('/api/tickets?status=queued,running'),
      200,
    )
    assert.ok(tickets.some((candidate) => candidate.number === created.number))
    assert.ok(
      tickets.every((candidate) =>
        ['queued', 'running'].includes(candidate.status),
      ),
    )
    const { tickets: done } = await json<TicketsResponse>(
      await app.request('/api/tickets?status=done'),
      200,
    )
    assert.ok(!done.some((candidate) => candidate.number === created.number))
    const invalid = await json<ErrorResponse>(
      await app.request('/api/tickets?status=finished'),
      400,
    )
    assert.match(invalid.issues?.join() ?? '', /queued/)
  })

  test('unknown numbers are 404', async () => {
    assert.deepEqual(
      await json<ErrorResponse>(await app.request('/api/tickets/9999'), 404),
      { error: 'No ticket #9999' },
    )
  })
})

describe('decisions', () => {
  test('approve, request changes with a comment, and refuse stale attempts', async () => {
    const { ticket: created } = await newTicket('acme/shop', 'Decide')
    await runStep(created.number, 'done', [
      { kind: 'plan', title: 'Plan', content: '# Plan' },
    ])
    const waiting = await ticket(created.number)
    assert.equal(waiting.ticket.waiting?.for, 'human')
    const attemptId = waiting.ticket.waiting?.attemptId

    const noComment = await json<ErrorResponse>(
      await post(`/api/tickets/${created.number}/decision`, {
        attemptId,
        choice: 'changes-needed',
      }),
      400,
    )
    assert.match(noComment.error, /requires a comment/)

    const changed = await json<TicketResponse>(
      await post(`/api/tickets/${created.number}/decision`, {
        attemptId,
        choice: 'changes-needed',
        comment: 'Mention the mobile layout',
      }),
      200,
    )
    assert.equal(changed.ticket.currentStep, 'plan')
    assert.equal(
      changed.workflow.steps.find((step) => step.id === 'plan')?.runs,
      1,
    )
    assert.equal(
      changed.workflow.steps.find((step) => step.id === 'approve-plan')?.runs,
      1,
    )
    const comment = changed.artifacts.find(
      (artifact) => artifact.kind === 'comment',
    )
    assert.equal(comment?.content, 'Mention the mobile layout')
    assert.equal(comment?.stepId, 'approve-plan')

    const stale = await json<ErrorResponse>(
      await post(`/api/tickets/${created.number}/decision`, {
        attemptId,
        choice: 'approved',
      }),
      409,
    )
    assert.match(stale.error, /moved on/)

    await runStep(created.number, 'done')
    const approved = await json<TicketResponse>(
      await post(`/api/tickets/${created.number}/decision`, {
        attemptId: (await ticket(created.number)).ticket.waiting?.attemptId,
        choice: 'approved',
      }),
      200,
    )
    assert.equal(approved.ticket.currentStep, 'build')
    assert.equal(approved.ticket.status, 'queued')
  })
})

describe('asks', () => {
  async function failedTicket(title: string) {
    const { ticket: created } = await newTicket('acme/shop', title)
    const claimed = await claimAttempts(database, 100)
    const mine = claimed.find(
      (context) => context.ticket.number === created.number,
    )
    assert.ok(mine)
    await markRunning(database, mine.attempt.id, 'codex')
    await failAttempt(database, mine.attempt.id, 'codex crashed')
    const asked = await ticket(created.number)
    assert.equal(asked.ticket.waiting?.askReason, 'failed')
    return asked
  }

  test('retry, move and cancel', async () => {
    const retry = await failedTicket('Retry me')
    const retried = await json<TicketResponse>(
      await post(`/api/tickets/${retry.ticket.number}/resolve`, {
        attemptId: retry.ticket.waiting?.attemptId,
        action: 'retry',
        note: 'Try again with more memory',
      }),
      200,
    )
    assert.equal(retried.ticket.status, 'queued')
    assert.equal(retried.artifacts.at(-1)?.title, 'Note for plan')

    const move = await failedTicket('Move me')
    const moved = await json<TicketResponse>(
      await post(`/api/tickets/${move.ticket.number}/resolve`, {
        attemptId: move.ticket.waiting?.attemptId,
        action: 'move',
        stepId: 'build',
      }),
      200,
    )
    assert.equal(moved.ticket.currentStep, 'build')

    const cancel = await failedTicket('Cancel me')
    const cancelled = await json<TicketResponse>(
      await post(`/api/tickets/${cancel.ticket.number}/resolve`, {
        attemptId: cancel.ticket.waiting?.attemptId,
        action: 'cancel',
      }),
      200,
    )
    assert.equal(cancelled.ticket.status, 'cancelled')
  })

  test('validate the resolution', async () => {
    const asked = await failedTicket('Invalid resolution')
    const path = `/api/tickets/${asked.ticket.number}/resolve`
    const attemptId = asked.ticket.waiting?.attemptId
    await json<ErrorResponse>(
      await post(path, { attemptId, action: 'move' }),
      400,
    )
    await json<ErrorResponse>(
      await post(path, { attemptId, action: 'skip' }),
      400,
    )
    assert.match(
      (
        await json<ErrorResponse>(
          await post(path, { attemptId, action: 'move', stepId: 'deploy' }),
          400,
        )
      ).error,
      /no step "deploy"/,
    )
    await json<ErrorResponse>(
      await post(`/api/tickets/${asked.ticket.number}/decision`, {
        attemptId,
        choice: 'approved',
      }),
      409,
    )
  })
})

describe('cancel', () => {
  test('cancels with or without a reason, once', async () => {
    const { ticket: created } = await newTicket('acme/shop', 'Cancel')
    const response = await app.request(
      `/api/tickets/${created.number}/cancel`,
      {
        method: 'POST',
      },
    )
    const cancelled = await json<TicketResponse>(response, 200)
    assert.equal(cancelled.ticket.status, 'cancelled')
    assert.equal(cancelled.attempts.at(-1)?.status, 'interrupted')
    await json<ErrorResponse>(
      await post(`/api/tickets/${created.number}/cancel`, {}),
      409,
    )

    const { ticket: other } = await newTicket('acme/shop', 'Cancel with reason')
    const withReason = await json<TicketResponse>(
      await post(`/api/tickets/${other.number}/cancel`, {
        reason: 'Duplicate',
      }),
      200,
    )
    assert.equal(withReason.artifacts.at(-1)?.content, 'Duplicate')
  })
})

describe('artifacts', () => {
  let artifactIds: Record<string, number>
  let outsideArtifactHome: string
  after(() => rm(outsideArtifactHome, { recursive: true, force: true }))

  before(async () => {
    await mkdir(join(home, 'evidence'), { recursive: true })
    await writeFile(
      join(home, 'evidence', 'shot.png'),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    )
    await writeFile(
      join(home, 'evidence', 'page.html'),
      '<script>alert(1)</script>',
    )
    const outside = await mkdtemp(join(tmpdir(), 'ksf-outside-'))
    outsideArtifactHome = outside
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(
      join(outside, 'secret.txt'),
      join(home, 'evidence', 'link.txt'),
    )

    const { ticket: created } = await newTicket('acme/shop', 'Artifacts')
    await runStep(created.number, 'done', [
      { kind: 'plan', title: 'Plan', content: '# The plan' },
      { kind: 'evidence', title: 'Screenshot', path: 'evidence/shot.png' },
      {
        kind: 'evidence',
        title: 'Page',
        path: join(home, 'evidence', 'page.html'),
      },
    ])
    // Legacy unsafe/missing rows exercise serving safety; new ingestion rejects them.
    const attempt = (await ticket(created.number)).attempts[0]!
    for (const [title, path] of [
      ['Escape', '../../etc/hosts'],
      ['Absolute', '/etc/hosts'],
      ['Symlink', 'evidence/link.txt'],
      ['Missing', 'evidence/missing.log'],
    ])
      await database.query(
        `INSERT INTO artifacts (ticket_id, attempt_id, kind, title, path) VALUES ($1, $2, 'log', $3, $4)`,
        [created.id, attempt.id, title, path],
      )
    const { artifacts } = await ticket(created.number)
    artifactIds = Object.fromEntries(
      artifacts.map((artifact) => [artifact.title, artifact.id]),
    )
  })

  const get = (title: string) =>
    app.request(`/api/artifacts/${artifactIds[title]}`)

  test('serves markdown content', async () => {
    const response = await get('Plan')
    assert.equal(response.status, 200)
    assert.equal(
      response.headers.get('Content-Type'),
      'text/markdown; charset=utf-8',
    )
    assert.equal(await response.text(), '# The plan')
    assert.match(
      response.headers.get('Content-Security-Policy') ?? '',
      /sandbox/,
    )
  })

  test('serves files inside the factory home', async () => {
    const image = await get('Screenshot')
    assert.equal(image.status, 200)
    assert.equal(image.headers.get('Content-Type'), 'image/png')
    assert.deepEqual(
      [...new Uint8Array(await image.arrayBuffer())],
      [137, 80, 78, 71, 13, 10, 26, 10],
    )
    const html = await get('Page')
    assert.equal(html.status, 200)
    assert.equal(html.headers.get('Content-Type'), 'text/plain; charset=utf-8')
    assert.equal(html.headers.get('X-Content-Type-Options'), 'nosniff')
  })

  test('refuses files outside the factory home, even through symlinks', async () => {
    for (const title of ['Escape', 'Absolute', 'Symlink']) {
      const response = await get(title)
      assert.equal(response.status, 403, title)
      assert.match(
        ((await response.json()) as ErrorResponse).error,
        /outside the factory home/,
      )
    }
  })

  test('serves bounded, open-ended and suffix byte ranges for seeking evidence', async () => {
    for (const [range, bytes, contentRange] of [
      ['bytes=1-3', [80, 78, 71], 'bytes 1-3/8'],
      ['bytes=6-', [26, 10], 'bytes 6-7/8'],
      ['bytes=-3', [10, 26, 10], 'bytes 5-7/8'],
      ['bytes=6-99', [26, 10], 'bytes 6-7/8'],
    ] as const) {
      const response = await app.request(
        `/api/artifacts/${artifactIds.Screenshot}`,
        { headers: { Range: range } },
      )
      assert.equal(response.status, 206)
      assert.equal(response.headers.get('Accept-Ranges'), 'bytes')
      assert.equal(response.headers.get('Content-Range'), contentRange)
      assert.equal(response.headers.get('Content-Length'), String(bytes.length))
      assert.equal(response.headers.get('Content-Type'), 'image/png')
      assert.deepEqual(
        [...new Uint8Array(await response.arrayBuffer())],
        [...bytes],
      )
    }
  })

  test('range errors and fallback preserve file safety and full responses', async () => {
    for (const range of ['bytes=8-', 'bytes=-0']) {
      const response = await app.request(
        `/api/artifacts/${artifactIds.Screenshot}`,
        { headers: { Range: range } },
      )
      assert.equal(response.status, 416)
      assert.equal(response.headers.get('Content-Range'), 'bytes */8')
      assert.equal(await response.text(), '')
    }
    for (const headers of [
      { Range: 'bytes=3-1' },
      { Range: 'bytes=0-1,4-5' },
      { Range: 'items=0-1' },
      { Range: 'bytes=0-1', 'If-Range': '"old-version"' },
    ]) {
      const response = await app.request(
        `/api/artifacts/${artifactIds.Screenshot}`,
        { headers },
      )
      assert.equal(response.status, 200)
      assert.equal((await response.arrayBuffer()).byteLength, 8)
    }
    for (const title of ['Escape', 'Absolute', 'Symlink'])
      assert.equal(
        (
          await app.request(`/api/artifacts/${artifactIds[title]}`, {
            headers: { Range: 'bytes=0-1' },
          })
        ).status,
        403,
      )
  })

  test('reports missing files and artifacts', async () => {
    assert.equal((await get('Missing')).status, 404)
    assert.equal((await app.request('/api/artifacts/999999')).status, 404)
  })
})

describe('event stream', () => {
  /** Reads SSE messages until `until` returns true or the time runs out. */
  async function readEvents(
    response: Response,
    until: (
      messages: { event?: string; id?: string; data: string }[],
    ) => boolean,
  ) {
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Content-Type'), 'text/event-stream')
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    const messages: { event?: string; id?: string; data: string }[] = []
    let buffer = ''
    const deadline = setTimeout(() => void reader.cancel(), 5000)
    try {
      while (!until(messages)) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let end: number
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const message: { event?: string; id?: string; data: string } = {
            data: '',
          }
          for (const line of frame.split('\n')) {
            const [field, ...rest] = line.split(': ')
            const fieldValue = rest.join(': ')
            if (field === 'event') message.event = fieldValue
            if (field === 'id') message.id = fieldValue
            if (field === 'data') message.data += fieldValue
          }
          if (message.data !== '') messages.push(message)
        }
      }
    } finally {
      clearTimeout(deadline)
      await reader.cancel()
    }
    return messages
  }

  test('replays events after Last-Event-ID', async () => {
    const { ticket: created, events: ticketEvents } = await newTicket(
      'acme/shop',
      'Replay',
    )
    const first = ticketEvents[0]
    assert.ok(first)
    const messages = await readEvents(
      await app.request('/api/events', {
        headers: { 'Last-Event-ID': String(first.id - 1) },
      }),
      (received) => received.length >= 3,
    )
    assert.equal(messages[0]?.event, 'ready')
    assert.deepEqual(JSON.parse(messages[0]?.data ?? ''), {
      lastEventId: first.id - 1,
    })
    const replayed = messages
      .slice(1)
      .map((message) => JSON.parse(message.data) as EventMessage)
    assert.deepEqual(
      replayed.map((event) => [event.kind, event.ticketNumber]),
      [
        ['ticket.created', created.number],
        ['attempt.queued', created.number],
      ],
    )
    assert.equal(messages[1]?.id, String(first.id))

    const viaQuery = await readEvents(
      await app.request(`/api/events?after=${first.id}`),
      (received) => received.length >= 2,
    )
    assert.equal(JSON.parse(viaQuery[1]?.data ?? '').kind, 'attempt.queued')
  })

  test('announces new events live', async () => {
    const response = await app.request('/api/events')
    let creating: Promise<unknown> | undefined
    const messages = await readEvents(response, (received) => {
      // Create the ticket only once the stream is open, so its events arrive live.
      if (received.length === 1 && !creating) {
        creating = newTicket('acme/shop', 'Live')
      }
      return received.some((message) => {
        const event =
          message.event === undefined ? JSON.parse(message.data) : null
        return event?.kind === 'attempt.queued'
      })
    })
    // The request finishes after its events are sent; let it finish before the pool closes.
    await creating
    const live = messages
      .filter((message) => message.event === undefined)
      .map((message) => JSON.parse(message.data) as EventMessage)
    assert.deepEqual(
      live.map((event) => event.kind),
      ['ticket.created', 'attempt.queued'],
    )
    assert.ok(live.every((event) => event.ticketNumber !== null))
  })

  test('rejects an invalid Last-Event-ID', async () => {
    const response = await app.request('/api/events', {
      headers: { 'Last-Event-ID': 'yesterday' },
    })
    assert.equal(response.status, 400)
  })
})

test('additive proof contract: kit status/capabilities, commit and media type in existing endpoints', async () => {
  const repository = await readyRepository('proof/api')
  await markRepositoryReady(database, repository.id, {
    kit: {
      status: 'invalid',
      error: 'verify.start: missing {port}',
      capabilities: [],
    },
  })
  let repositories = await json<RepositoriesResponse>(
    await app.request('/api/repositories'),
    200,
  )
  assert.deepEqual(
    repositories.repositories.find((r) => r.id === repository.id)!.kit,
    {
      status: 'invalid',
      error: 'verify.start: missing {port}',
      capabilities: [],
    },
  )
  await markRepositoryReady(database, repository.id, {
    kit: { status: 'valid', error: null, capabilities: ['setup', 'verify'] },
  })
  repositories = await json<RepositoriesResponse>(
    await app.request('/api/repositories'),
    200,
  )
  assert.deepEqual(
    repositories.repositories.find((r) => r.id === repository.id)!.capabilities,
    ['setup', 'verify'],
  )
  const { ticket: created } = await newTicket('proof/api')
  const [claimed] = (await claimAttempts(database, 100)).filter(
    (c) => c.ticket.id === created.id,
  )
  assert.ok(claimed)
  await markRunning(database, claimed.attempt.id, 'codex')
  const path = join(home, 'misleading-name.txt')
  await writeFile(path, Buffer.from('89504e470d0a1a0a', 'hex'))
  const commit = 'c'.repeat(40)
  await completeAttempt(
    database,
    claimed.attempt.id,
    {
      outcome: 'done',
      summary: 'Recorded',
      artifacts: [
        { kind: 'evidence', title: 'Detected image', path },
        { kind: 'plan', title: 'Plan', content: 'Plan' },
      ],
    },
    { headCommit: commit },
  )
  const detail = await json<TicketResponse>(
    await app.request(`/api/tickets/${created.number}`),
    200,
  )
  assert.equal(detail.attempts[0]!.headCommit, commit)
  assert.equal(detail.attempts[1]!.headCommit, null)
  const image = detail.artifacts.find((a) => a.title === 'Detected image')!
  assert.equal(image.mediaType, 'image/png')
  assert.equal(
    detail.artifacts.find((a) => a.kind === 'plan')!.mediaType,
    'text/markdown',
  )
  assert.equal(
    (await app.request(`/api/artifacts/${image.id}`)).headers.get(
      'content-type',
    ),
    image.mediaType,
  )
})
