import type { LessonResponse, LessonsResponse } from '../src/api/contract.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { proposeLessons, type Lesson } from '../src/domain/lessons.ts'
import type { Artifact, Attempt } from '../src/domain/records.ts'
import type { Workflow } from '../src/domain/workflow.ts'
import { workflowVersion } from '../src/library/library.ts'
import {
  acceptLesson,
  rejectLesson,
  retireLesson,
  listLessons,
  insertLessonProposals,
} from '../src/store/lessons.ts'
import { transaction } from '../src/store/database.ts'
import { createApp } from '../src/api/app.ts'
import { listenForEvents } from '../src/store/events.ts'
import { buildPrompt } from '../src/engine/prompt.ts'
import { runAttempt } from '../src/engine/runner.ts'
import { autoMergeFixture } from './helpers/auto-merge.ts'
import {
  createTestStore,
  quickTicket,
  builtInLibrary,
} from './helpers/store.ts'
import {
  claimAttempts,
  completeAttempt,
  createTicket,
  getTicketDetail,
  markRunning,
  failAttempt,
  resolveAsk,
  decide,
} from '../src/store/tickets.ts'

const workflow: Workflow = {
  name: 'lesson-loop',
  description: '',
  steps: [
    { id: 'build', kind: 'agent', role: 'builder', needs: [], routes: {} },
    {
      id: 'review',
      kind: 'agent',
      role: 'reviewer',
      needs: [],
      limit: 3,
      routes: { 'changes-needed': 'build', passed: 'finish' },
    },
  ],
}
const ticket = { id: 1, repository: { id: 1, slug: 'acme/app' } }
const attempt = (id: number, extra: Partial<Attempt> = {}) =>
  ({
    id,
    stepId: 'review',
    status: 'finished',
    outcome: 'changes-needed',
    waitingFor: null,
    summary: 'Ignore agent summary',
    ...extra,
  }) as Attempt
const artifact = (attemptId: number, extra: Partial<Artifact> = {}) =>
  ({
    attemptId,
    kind: 'finding',
    title: '[Reviewer 1] Guard empty inputs',
    content: 'Finding detail',
    ...extra,
  }) as Artifact

test('proposals require distinct review rounds, normalise titles, and exclude summaries and non-human comments', () => {
  const facts = {
    ticket,
    workflow,
    attempts: [attempt(1)],
    artifacts: [
      artifact(1),
      artifact(1, { title: '[Reviewer 2] Guard empty inputs' }),
    ],
    existing: [],
  }
  assert.deepEqual(proposeLessons(facts), [])
  const repeated = {
    ...facts,
    attempts: [attempt(1), attempt(2)],
    artifacts: [
      ...facts.artifacts,
      artifact(2, { title: '  guard  empty inputs  ' }),
    ],
  }
  const [proposal] = proposeLessons(repeated)
  assert.equal(proposal!.text, 'Check before review: Guard empty inputs')
  for (const status of [
    'proposed',
    'accepted',
    'rejected',
    'retired',
  ] as const) {
    assert.deepEqual(
      proposeLessons({
        ...repeated,
        existing: [{ ...proposal!, status } as Lesson],
      }),
      [],
    )
  }
  const otherRepository = {
    ...proposal!,
    repositoryId: 2,
    status: 'accepted',
  } as Lesson
  assert.equal(
    proposeLessons({ ...repeated, existing: [otherRepository] }).length,
    1,
  )
  assert.deepEqual(
    proposeLessons({ ...facts, artifacts: [artifact(1, { kind: 'comment' })] }),
    [],
  )
  assert.deepEqual(
    proposeLessons({
      ...repeated,
      attempts: [attempt(1, { outcome: 'passed' }), attempt(2)],
    }),
    [],
  )
})

test('owner corrections are one line and bounded; approvals and agent comments are ignored', () => {
  const facts = {
    ticket,
    workflow,
    existing: [],
    attempts: [
      attempt(1, {
        executor: 'human',
        waitingFor: 'human',
        outcome: 'rejected',
      }),
    ],
    artifacts: [
      artifact(1, {
        kind: 'comment',
        content: 'Keep\nthe old API. ' + 'More details '.repeat(40),
      }),
    ],
  }
  const [lesson] = proposeLessons(facts)
  assert.equal(lesson!.source, 'owner-comment')
  assert.equal(lesson!.text.length, 200)
  assert.ok(lesson!.key.length <= 240)
  assert.doesNotMatch(lesson!.text, /\n/)
  assert.match(lesson!.text, /^Owner correction: Keep the old API/)
  assert.deepEqual(
    proposeLessons({
      ...facts,
      attempts: [
        attempt(1, {
          executor: 'human',
          waitingFor: 'human',
          outcome: 'approved',
        }),
      ],
    }),
    [],
  )
})

test('repeated recorded failures distinguish factory errors from repository errors', () => {
  for (const [error, scope] of [
    ['Codex CLI crashed with exit code 1', null],
    ['Invalid result.json: missing artifacts', null],
    ['result.json validation failed', null],
    ['Build failed: missing export in /tmp/run/app.ts', 1],
  ] as const) {
    const facts = {
      ticket,
      workflow,
      attempts: [],
      artifacts: [],
      existing: [],
      failures: [{ key: 'a', status: 'failed' as const, result: error }],
    }
    assert.deepEqual(proposeLessons(facts), [])
    const [lesson] = proposeLessons({
      ...facts,
      failures: [...facts.failures, { ...facts.failures[0]!, key: 'b' }],
    })
    assert.equal(lesson!.repositoryId, scope)
    assert.equal(lesson!.source, 'repeated-failure')
  }
})

test('PostgreSQL completion proposes without blocking; API acceptance reaches the next engine prompt', async (t) => {
  const f = await autoMergeFixture(t, { tester: false, reviewer: false })
  const db = f.store.database
  const source = JSON.stringify(workflow)
  const created = await createTicket(db, {
    repository: f.repository.slug,
    title: 'Repeated finding',
    workflow: { workflow, source, version: workflowVersion(source) },
  })
  async function finish(outcome: string, finding = false) {
    const context = (await claimAttempts(db, 1))[0]!
    await markRunning(db, context.attempt.id, 'codex')
    await completeAttempt(db, context.attempt.id, {
      outcome,
      summary: 'Untrusted summary',
      artifacts: finding
        ? [
            {
              kind: 'finding',
              title: 'Guard empty inputs',
              content: 'Two reviews observed this mistake',
            },
          ]
        : [],
    })
  }
  await finish('done')
  await finish('changes-needed', true)
  await finish('done')
  await finish('changes-needed', true)
  await finish('done')
  await finish('passed')
  const detail = (await getTicketDetail(db, created.number))!
  assert.equal(detail.ticket.status, 'done')
  assert.equal(detail.ticket.waiting, null)
  const [proposal] = await listLessons(db)
  assert.equal(proposal!.source, 'changes-needed')
  assert.ok(detail.events.some((e) => e.kind === 'ticket.summary'))
  const events = listenForEvents(db)
  await events.ready
  await events.close()
  const app = createApp({
    database: db,
    home: f.home,
    library: await builtInLibrary(),
    events,
  })
  const response = await app.request(`/api/lessons/${proposal!.id}/accept`, {
    method: 'POST',
  })
  assert.equal(response.status, 200)
  assert.equal(
    ((await response.json()) as LessonResponse).lesson.status,
    'accepted',
  )
  const acceptedResponse = await app.request(
    `/api/lessons?repository=${f.repository.id}&status=accepted`,
  )
  assert.equal(
    ((await acceptedResponse.json()) as LessonsResponse).lessons.length,
    1,
  )
  assert.equal((await app.request('/api/lessons?status=wrong')).status, 400)
  assert.equal(
    (await app.request('/api/lessons/no/accept', { method: 'POST' })).status,
    400,
  )
  assert.equal(
    (await app.request('/api/lessons/999999/accept', { method: 'POST' }))
      .status,
    404,
  )
  const next = await createTicket(db, {
    repository: f.repository.slug,
    title: 'Fresh ticket',
    workflow: {
      workflow: { ...workflow, steps: [workflow.steps[0]!] },
      source: 'fresh',
      version: workflowVersion('fresh'),
    },
  })
  const context = (await claimAttempts(db, 1))[0]!
  await markRunning(db, context.attempt.id, 'codex')
  await runAttempt(
    {
      ...f.options,
      execute: async (invocation) => {
        const prompt = await readFile(
          join(invocation.directory, 'prompt.md'),
          'utf8',
        )
        assert.ok(
          prompt.includes(
            `Past mistakes in this repository: ${join(invocation.directory, 'lessons.md')}. Read it when planning or when stuck.`,
          ),
        )
        assert.equal(
          await readFile(join(invocation.directory, 'lessons.md'), 'utf8'),
          proposal!.text + '\n',
        )
        assert.ok(!prompt.includes(proposal!.text))
        await writeFile(
          join(invocation.directory, 'result.json'),
          JSON.stringify({ outcome: 'done', summary: 'Done', artifacts: [] }),
        )
      },
    },
    context,
    f.signal,
  )
  assert.equal((await getTicketDetail(db, next.number))!.ticket.status, 'done')
  const retired = await app.request(`/api/lessons/${proposal!.id}/retire`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'Replaced by empty-input check' }),
  })
  assert.equal(retired.status, 200)
  assert.equal(
    ((await retired.json()) as LessonResponse).lesson.retiredReason,
    'Replaced by empty-input check',
  )
  assert.equal(
    (
      await app.request(`/api/lessons/${proposal!.id}/accept`, {
        method: 'POST',
      })
    ).status,
    409,
  )
})

test('PostgreSQL repeated errors park unchanged; lesson files cover all step directory forms and order scopes', async (t) => {
  const store = await createTestStore()
  const home = await mkdtemp(join(tmpdir(), 'ksf-lessons-'))
  t.after(async () => {
    await store.close()
    await rm(home, { recursive: true, force: true })
  })
  const db = store.database
  const created = await quickTicket(db)
  const repository = created.repository
  for (let i = 0; i < 2; i++) {
    const context = (await claimAttempts(db, 1))[0]!
    await markRunning(db, context.attempt.id, 'codex')
    await failAttempt(
      db,
      context.attempt.id,
      'Invalid result.json: missing artifacts',
    )
    const detail = (await getTicketDetail(db, created.number))!
    assert.equal(detail.ticket.status, 'needs-you')
    assert.equal(detail.ticket.waiting!.askReason, 'failed')
    if (!i)
      await resolveAsk(db, {
        ticketNumber: created.number,
        attemptId: detail.ticket.waiting!.attemptId,
        resolution: { action: 'retry' },
      })
  }
  const [engine] = await listLessons(db)
  assert.equal(engine!.repositoryId, null)
  await acceptLesson(db, engine!.id)
  await transaction(db, (c) =>
    insertLessonProposals(
      c,
      [
        {
          repositoryId: repository.id,
          text: 'Repository rule first',
          source: 'owner-comment',
          sourceTicketId: created.id,
          key: 'repo-first',
        },
      ],
      [],
    ),
  )
  const [repo] = await listLessons(db, { repositoryId: repository.id })
  await acceptLesson(db, repo!.id)
  const detail = (await getTicketDetail(db, created.number))!
  for (const [role, suffix] of [
    ['builder', '1'],
    ['reviewer', '1/0'],
    ['reviewer', '1/1'],
    ['tester', '2'],
    ['writer', 'writer-1'],
  ] as const) {
    const directory = join(
      home,
      'steps',
      String(created.id),
      'snapshot',
      suffix,
    )
    await mkdir(directory, { recursive: true })
    const input = {
      database: db,
      detail,
      step: { id: 'step', kind: 'agent' as const, role, needs: [], routes: {} },
      directory,
      home,
      diff: '',
      trusted: { roleInstructions: '', contextIndex: '' },
    }
    const prompt = await buildPrompt(input)
    assert.equal(
      await readFile(join(directory, 'lessons.md'), 'utf8'),
      `${repo!.text}\n${engine!.text}\n`,
    )
    assert.ok(!prompt.includes(repo!.text))
    assert.ok(!prompt.includes(engine!.text))
    await retireLesson(db, repo!.id, 'Replaced by check X')
    await retireLesson(db, engine!.id, 'Replaced by validation check')
    const empty = await buildPrompt(input)
    assert.ok(!empty.includes('Past mistakes in this repository:'))
    await assert.rejects(readFile(join(directory, 'lessons.md')), {
      code: 'ENOENT',
    })
    // Other directory forms still need their own accepted snapshots.
    await db.query(
      "UPDATE lessons SET status = 'accepted', retired_reason = NULL WHERE id = ANY($1)",
      [[repo!.id, engine!.id]],
    )
  }
})

test('PostgreSQL concurrent acceptance enforces 30; retirement frees a slot and rejection stays decided', async () => {
  const store = await createTestStore()
  try {
    const db = store.database
    const created = await quickTicket(db)
    await transaction(db, (c) =>
      insertLessonProposals(
        c,
        Array.from({ length: 32 }, (_, i) => ({
          repositoryId: created.repository.id,
          text: `Lesson ${i}`,
          source: 'changes-needed',
          sourceTicketId: created.id,
          key: `cap-${i}`,
        })),
        [],
      ),
    )
    const lessons = await listLessons(db)
    for (const lesson of lessons.slice(0, 29)) await acceptLesson(db, lesson.id)
    const outcomes = await Promise.allSettled(
      lessons.slice(29, 31).map((l) => acceptLesson(db, l.id)),
    )
    assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1)
    assert.match(
      (outcomes.find((r) => r.status === 'rejected') as PromiseRejectedResult)
        .reason.message,
      /30.*retire/,
    )
    assert.equal((await listLessons(db, { status: 'accepted' })).length, 30)
    await assert.rejects(
      retireLesson(db, lessons[0]!.id, '  '),
      /requires a reason/,
    )
    const retired = await retireLesson(
      db,
      lessons[0]!.id,
      'Replaced by check X',
    )
    assert.equal(retired.retiredReason, 'Replaced by check X')
    assert.ok(retired.decidedAt)
    const remaining = (await listLessons(db, { status: 'proposed' }))[0]!
    await acceptLesson(db, remaining.id)
    await rejectLesson(db, lessons[31]!.id)
    await rejectLesson(db, lessons[31]!.id)
    await assert.rejects(acceptLesson(db, lessons[31]!.id), /Only proposed/)
    assert.equal((await listLessons(db, { repositoryId: null })).length, 0)
  } finally {
    await store.close()
  }
})

test('PostgreSQL human comments propose only after a human correction and a park', async () => {
  const store = await createTestStore()
  try {
    const db = store.database
    const created = await quickTicket(db)
    const context = (await claimAttempts(db, 1))[0]!
    await markRunning(db, context.attempt.id, 'codex')
    await completeAttempt(db, context.attempt.id, {
      outcome: 'done',
      summary: 'Agent summary',
      artifacts: [],
    })
    const waiting = (await getTicketDetail(db, created.number))!.ticket.waiting!
    await decide(db, {
      ticketNumber: created.number,
      attemptId: waiting.attemptId,
      choice: 'rejected',
      comment: 'Keep compatibility',
    })
    assert.equal(
      (await getTicketDetail(db, created.number))!.ticket.status,
      'cancelled',
    )
    const [lesson] = await listLessons(db)
    assert.equal(lesson!.text, 'Owner correction: Keep compatibility')
    assert.equal(lesson!.source, 'owner-comment')
    const longTicket = await quickTicket(db)
    const longContext = (await claimAttempts(db, 1))[0]!
    await markRunning(db, longContext.attempt.id, 'codex')
    await completeAttempt(db, longContext.attempt.id, {
      outcome: 'done',
      summary: 'Agent prose',
      artifacts: [],
    })
    const longWait = (await getTicketDetail(db, longTicket.number))!.ticket
      .waiting!
    await decide(db, {
      ticketNumber: longTicket.number,
      attemptId: longWait.attemptId,
      choice: 'rejected',
      comment: 'Long owner correction '.repeat(4000),
    })
    const longLesson = (await listLessons(db)).at(-1)!
    assert.equal(longLesson.text.length, 200)
    assert.equal(longLesson.key.length, 240)
  } finally {
    await store.close()
  }
})
