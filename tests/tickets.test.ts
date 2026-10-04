import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { ArtifactInput } from '../src/domain/lifecycle.ts'
import type { Database } from '../src/store/database.ts'
import { listenForEvents, listEvents } from '../src/store/events.ts'
import {
  createRepository,
  listRepositories,
  markRepositoryFailed,
  markRepositoryReady,
} from '../src/store/repositories.ts'
import {
  cancelTicket,
  claimAttempts,
  completeAttempt,
  createTicket,
  decide,
  failAttempt,
  getTicket,
  getTicketDetail,
  interruptRunning,
  listAttempts,
  listTickets,
  listWaitingForMerge,
  markRunning,
  resolveAsk,
  setPullRequestUrl,
  waitForPullRequestMerge,
} from '../src/store/tickets.ts'
import {
  assertFactoryError,
  builtInWorkflow,
  createTestStore,
  quickTicket,
  type TestStore,
} from './helpers/store.ts'

let store: TestStore
let database: Database

before(async () => {
  store = await createTestStore()
  database = store.database
})

after(() => store.close())

/** Claims the given ticket's pending attempt and starts it. */
async function start(db: Database, number: number): Promise<number> {
  const ticket = await getTicket(db, number)
  const attempts = await listAttempts(db, ticket?.id ?? 0)
  const pending = attempts.at(-1)
  assert.equal(
    pending?.status,
    'pending',
    `ticket #${number} has no pending attempt`,
  )
  // Other tests' tickets may be pending too; claim until this one is ours.
  while (pending.claimedAt === null) {
    const claimed = await claimAttempts(db, 1)
    assert.ok(claimed[0], 'nothing left to claim')
    if (claimed[0].attempt.id === pending.id) break
  }
  await markRunning(db, pending.id, 'claude-code')
  return pending.id
}

async function finish(
  db: Database,
  number: number,
  outcome: string,
  artifacts: ArtifactInput[] = [],
) {
  const attemptId = await start(db, number)
  return completeAttempt(db, attemptId, {
    outcome,
    summary: `Reported ${outcome}`,
    artifacts,
  })
}

async function waitingId(db: Database, number: number): Promise<number> {
  const ticket = await getTicket(db, number)
  assert.ok(ticket?.waiting, `ticket #${number} is not waiting`)
  return ticket.waiting.attemptId
}

describe('repositories', () => {
  test('register as pending with GitHub defaults, unique ignoring case', async () => {
    const repository = await createRepository(database, { slug: 'acme/api' })
    assert.equal(repository.status, 'pending')
    assert.equal(repository.cloneUrl, 'https://github.com/acme/api.git')
    assert.equal(repository.defaultBranch, 'main')
    assert.deepEqual(repository.capabilities, [])
    await assertFactoryError(
      createRepository(database, { slug: 'ACME/api' }),
      'conflict',
      /already registered/,
    )
  })

  test('are marked ready or failed', async () => {
    const repository = await createRepository(database, { slug: 'acme/docs' })
    const failed = await markRepositoryFailed(
      database,
      repository.id,
      'clone failed',
    )
    assert.equal(failed.status, 'failed')
    assert.equal(failed.lastError, 'clone failed')
    const ready = await markRepositoryReady(database, repository.id, {
      defaultBranch: 'trunk',
      capabilities: ['setup'],
    })
    assert.equal(ready.status, 'ready')
    assert.equal(ready.lastError, null)
    assert.equal(ready.defaultBranch, 'trunk')
    assert.deepEqual(ready.capabilities, ['setup'])
    const listed = await listRepositories(database, { status: 'ready' })
    assert.ok(listed.some((candidate) => candidate.slug === 'acme/docs'))
    const kinds = (await listEvents(database))
      .filter((event) => event.data['repositoryId'] === repository.id)
      .map((event) => event.kind)
    assert.deepEqual(kinds, [
      'repository.created',
      'repository.failed',
      'repository.ready',
    ])
  })
})

describe('creating tickets', () => {
  test('queues the first step and records the workflow version', async () => {
    const ticket = await quickTicket(database, {
      title: 'Fix the login redirect',
    })
    assert.equal(ticket.status, 'queued')
    assert.equal(ticket.currentStep, 'plan')
    assert.equal(ticket.repository.slug, 'acme/shop')
    assert.equal(ticket.workflow.name, 'quick-change')
    assert.equal(
      ticket.workflow.version,
      (await builtInWorkflow('quick-change')).version,
    )
    assert.equal(
      ticket.branch,
      `kipster/${ticket.number}-fix-the-login-redirect`,
    )
    assert.equal(ticket.waiting, null)
    const attempts = await listAttempts(database, ticket.id)
    assert.deepEqual(
      attempts.map((attempt) => [attempt.stepId, attempt.status]),
      [['plan', 'pending']],
    )
    const kinds = (await listEvents(database, { ticketId: ticket.id })).map(
      (event) => event.kind,
    )
    assert.deepEqual(kinds, ['ticket.created', 'attempt.queued'])
  })

  test('numbers tickets #1, #2, …', async () => {
    const fresh = await createTestStore()
    try {
      const first = await quickTicket(fresh.database)
      const second = await quickTicket(fresh.database)
      assert.deepEqual([first.number, second.number], [1, 2])
    } finally {
      await fresh.close()
    }
  })

  test('rejects workflows needing capabilities the repository lacks', async () => {
    await quickTicket(database)
    for (const name of ['feature', 'bug']) {
      await assertFactoryError(
        createTicket(database, {
          repository: 'acme/shop',
          workflow: await builtInWorkflow(name),
          title: 'Needs verify',
        }),
        'invalid',
        new RegExp(
          `Workflow "${name}" needs capabilities that acme/shop does not provide: verify`,
        ),
      )
    }
  })

  test('needs a registered, ready repository', async () => {
    const workflow = await builtInWorkflow('quick-change')
    await assertFactoryError(
      createTicket(database, {
        repository: 'nobody/here',
        workflow,
        title: 'x',
      }),
      'invalid',
      /No repository nobody\/here/,
    )
    const pending = await createRepository(database, { slug: 'acme/pending' })
    await assertFactoryError(
      createTicket(database, {
        repository: 'acme/pending',
        workflow,
        title: 'x',
      }),
      'conflict',
      /acme\/pending is pending; tickets can start once it is ready/,
    )
    await markRepositoryFailed(database, pending.id, 'clone failed')
    await assertFactoryError(
      createTicket(database, {
        repository: 'acme/pending',
        workflow,
        title: 'x',
      }),
      'conflict',
      /is failed \(clone failed\)/,
    )
  })
})

describe('the quick-change lifecycle', () => {
  test('runs from plan to done', async () => {
    const { number } = await quickTicket(database)

    await finish(database, number, 'done', [
      { kind: 'plan', title: 'Plan', content: '# Plan\n\n1. Do it' },
    ])
    let ticket = await getTicket(database, number)
    assert.equal(ticket?.status, 'needs-you')
    assert.equal(ticket?.waiting?.for, 'human')
    assert.equal(ticket?.waiting?.stepId, 'approve-plan')

    await decide(database, {
      ticketNumber: number,
      attemptId: await waitingId(database, number),
      choice: 'changes-needed',
      comment: 'Cover the empty state',
    })
    assert.equal((await getTicket(database, number))?.currentStep, 'plan')
    await finish(database, number, 'done')
    await decide(database, {
      ticketNumber: number,
      attemptId: await waitingId(database, number),
      choice: 'approved',
    })
    await finish(database, number, 'done')
    await finish(database, number, 'changes-needed', [
      { kind: 'finding', title: 'Review', content: 'Missing a test' },
    ])
    await finish(database, number, 'done')
    await finish(database, number, 'passed')
    await finish(database, number, 'ci-failed')
    await finish(database, number, 'done')
    await finish(database, number, 'passed')
    await finish(database, number, 'ready')
    const moved = await finish(database, number, 'merged')
    assert.equal(moved.ticket.status, 'done')
    assert.equal(moved.opened, null)
    assert.deepEqual(moved.closed.next, { to: 'finish' })

    const detail = await getTicketDetail(database, number)
    assert.ok(detail)
    assert.deepEqual(
      detail.attempts.map((attempt) => `${attempt.stepId}:${attempt.outcome}`),
      [
        'plan:done',
        'approve-plan:changes-needed',
        'plan:done',
        'approve-plan:approved',
        'build:done',
        'review:changes-needed',
        'build:done',
        'review:passed',
        'maintain-pr:ci-failed',
        'build:done',
        'review:passed',
        'maintain-pr:ready',
        'merge:merged',
      ],
    )
    assert.ok(detail.attempts.every((attempt) => attempt.status === 'finished'))
    assert.deepEqual(
      detail.artifacts.map((artifact) => [artifact.stepId, artifact.kind]),
      [
        ['plan', 'plan'],
        ['approve-plan', 'comment'],
        ['review', 'finding'],
      ],
    )
    assert.equal(detail.artifacts[1]?.content, 'Cover the empty state')
    assert.equal(
      detail.attempts[1]?.summary,
      'Cover the empty state',
      'the comment is also the human attempt summary',
    )
    const statuses = detail.events
      .filter((event) => event.kind === 'ticket.status')
      .map((event) => event.data['to'])
    assert.equal(statuses.at(-1), 'done')
    assert.ok(detail.events.every((event) => event.ticketNumber === number))
  })

  test('review asks you once it reaches its limit', async () => {
    const { number } = await quickTicket(database)
    await finish(database, number, 'done')
    await decide(database, {
      ticketNumber: number,
      attemptId: await waitingId(database, number),
      choice: 'approved',
    })
    await finish(database, number, 'done')
    await finish(database, number, 'changes-needed')
    await finish(database, number, 'done')
    const moved = await finish(database, number, 'changes-needed')
    assert.deepEqual(moved.closed.next, { to: 'ask', because: 'limit' })
    assert.equal(moved.ticket.status, 'needs-you')
    assert.deepEqual(
      moved.ticket.waiting && {
        for: moved.ticket.waiting.for,
        stepId: moved.ticket.waiting.stepId,
        askReason: moved.ticket.waiting.askReason,
      },
      { for: 'ask', stepId: 'review', askReason: 'limit' },
    )
    assert.match(
      moved.ticket.waiting?.summary ?? '',
      /review reported changes-needed after 2 runs/,
    )
  })

  test('a rejected plan cancels the ticket', async () => {
    const { number } = await quickTicket(database)
    await finish(database, number, 'done')
    const moved = await decide(database, {
      ticketNumber: number,
      attemptId: await waitingId(database, number),
      choice: 'rejected',
    })
    assert.equal(moved.ticket.status, 'cancelled')
    assert.equal(moved.ticket.currentStep, 'approve-plan')
  })

  test('an invalid result changes nothing', async () => {
    const { number } = await quickTicket(database)
    const attemptId = await start(database, number)
    await assertFactoryError(
      completeAttempt(database, attemptId, {
        outcome: 'passed',
        summary: 'x',
        artifacts: [{ kind: 'plan', title: 'Plan', content: 'kept?' }],
      }),
      'invalid',
      /cannot report "passed"/,
    )
    await assertFactoryError(
      completeAttempt(database, attemptId, { outcome: 'done' }),
      'invalid',
      /summary/,
    )
    const detail = await getTicketDetail(database, number)
    assert.equal(detail?.ticket.status, 'running')
    assert.equal(detail?.artifacts.length, 0)
  })

  test('decisions and resolutions must name the open attempt', async () => {
    const { number } = await quickTicket(database)
    await finish(database, number, 'done')
    const attemptId = await waitingId(database, number)
    await assertFactoryError(
      decide(database, {
        ticketNumber: number,
        attemptId: attemptId - 1,
        choice: 'approved',
      }),
      'conflict',
      /no longer open; the ticket has moved on/,
    )
    await assertFactoryError(
      decide(database, {
        ticketNumber: number,
        attemptId,
        choice: 'changes-needed',
      }),
      'invalid',
      /requires a comment/,
    )
    await assertFactoryError(
      resolveAsk(database, {
        ticketNumber: number,
        attemptId,
        resolution: { action: 'retry' },
      }),
      'conflict',
      /not waiting on an ask/,
    )
    await assertFactoryError(
      decide(database, { ticketNumber: 99_999, attemptId, choice: 'approved' }),
      'not-found',
      /No ticket #99999/,
    )
  })
})

describe('asks', () => {
  test('a failed attempt asks; retry runs it again with your note', async () => {
    const { number } = await quickTicket(database)
    const attemptId = await start(database, number)
    const failed = await failAttempt(
      database,
      attemptId,
      'claude exited with 1',
    )
    assert.equal(failed.closed.status, 'failed')
    assert.equal(failed.closed.error, 'claude exited with 1')
    assert.equal(failed.ticket.waiting?.askReason, 'failed')
    assert.equal(
      failed.ticket.waiting?.summary,
      'plan failed: claude exited with 1',
    )

    const retried = await resolveAsk(database, {
      ticketNumber: number,
      attemptId: await waitingId(database, number),
      resolution: { action: 'retry' },
      note: 'The API key was missing; it is set now.',
    })
    assert.equal(retried.ticket.status, 'queued')
    assert.equal(retried.opened?.stepId, 'plan')
    const detail = await getTicketDetail(database, number)
    const note = detail?.artifacts.at(-1)
    assert.equal(note?.kind, 'note')
    assert.equal(note?.title, 'Note for plan')
    assert.equal(note?.content, 'The API key was missing; it is set now.')
  })

  test('move goes to any step; cancel ends the ticket', async () => {
    const { number } = await quickTicket(database)
    await failAttempt(database, await start(database, number), 'boom')
    const moved = await resolveAsk(database, {
      ticketNumber: number,
      attemptId: await waitingId(database, number),
      resolution: { action: 'move', stepId: 'approve-plan' },
    })
    assert.equal(moved.ticket.waiting?.for, 'human')

    const other = await quickTicket(database)
    await failAttempt(database, await start(database, other.number), 'boom')
    await assertFactoryError(
      resolveAsk(database, {
        ticketNumber: other.number,
        attemptId: await waitingId(database, other.number),
        resolution: { action: 'move', stepId: 'deploy' },
      }),
      'invalid',
      /no step "deploy"/,
    )
    const cancelled = await resolveAsk(database, {
      ticketNumber: other.number,
      attemptId: await waitingId(database, other.number),
      resolution: { action: 'cancel' },
      note: 'Not needed any more',
    })
    assert.equal(cancelled.ticket.status, 'cancelled')
    assert.equal(cancelled.ticket.waiting, null)
  })
})

describe('waiting for a pull request merge', () => {
  test('parks the merge step until it is completed', async () => {
    const { number, id } = await quickTicket(database)
    await finish(database, number, 'done')
    await decide(database, {
      ticketNumber: number,
      attemptId: await waitingId(database, number),
      choice: 'approved',
    })
    for (const outcome of ['done', 'passed', 'ready']) {
      await finish(database, number, outcome)
    }
    const mergeId = await start(database, number)
    await setPullRequestUrl(database, id, 'https://github.com/acme/shop/pull/7')
    await assertFactoryError(
      waitForPullRequestMerge(database, mergeId + 1),
      'not-found',
      /No attempt/,
    )
    const waiting = await waitForPullRequestMerge(database, mergeId)
    assert.equal(waiting.status, 'waiting')
    assert.equal(waiting.waitingFor, 'pull-request-merge')
    const ticket = await getTicket(database, number)
    assert.equal(ticket?.status, 'needs-you')
    assert.equal(ticket?.waiting?.for, 'pull-request-merge')
    assert.equal(ticket?.pullRequestUrl, 'https://github.com/acme/shop/pull/7')

    const watched = await listWaitingForMerge(database)
    const mine = watched.find((context) => context.attempt.id === mergeId)
    assert.equal(mine?.step.id, 'merge')
    assert.equal(mine?.repository.slug, 'acme/shop')

    const moved = await completeAttempt(database, mergeId, {
      outcome: 'merged',
      summary: 'Merged by the owner',
    })
    assert.equal(moved.ticket.status, 'done')
  })
})

describe('cancelling', () => {
  test('stops the open attempt and keeps your reason', async () => {
    const { number } = await quickTicket(database)
    const attemptId = await start(database, number)
    const moved = await cancelTicket(database, {
      ticketNumber: number,
      reason: 'Duplicate of #1',
    })
    assert.equal(moved.ticket.status, 'cancelled')
    assert.equal(moved.closed.status, 'interrupted')
    assert.deepEqual(moved.closed.next, { to: 'cancel' })
    await assertFactoryError(
      completeAttempt(database, attemptId, {
        outcome: 'done',
        summary: 'late',
      }),
      'conflict',
      /is interrupted and no longer open/,
    )
    await assertFactoryError(
      cancelTicket(database, { ticketNumber: number }),
      'conflict',
      /already ended/,
    )
    const detail = await getTicketDetail(database, number)
    assert.equal(detail?.artifacts.at(-1)?.content, 'Duplicate of #1')
  })
})

describe('claiming', () => {
  test('claims oldest first, up to the limit, and never twice', async () => {
    const fresh = await createTestStore()
    try {
      const tickets = []
      for (let index = 0; index < 5; index++) {
        tickets.push(await quickTicket(fresh.database))
      }
      const first = await claimAttempts(fresh.database, 2)
      assert.deepEqual(
        first.map((context) => context.ticket.number),
        [1, 2],
      )
      assert.equal(first[0]?.step.id, 'plan')
      assert.equal(first[0]?.repository.slug, 'acme/shop')
      assert.ok(first[0]?.attempt.claimedAt)
      assert.equal(first[0]?.ticket.status, 'queued')
      const rest = await claimAttempts(fresh.database, 10)
      assert.deepEqual(
        rest.map((context) => context.ticket.number),
        [3, 4, 5],
      )
      assert.deepEqual(await claimAttempts(fresh.database, 10), [])
    } finally {
      await fresh.close()
    }
  })

  test('concurrent schedulers claim disjoint attempts', async () => {
    const fresh = await createTestStore()
    try {
      for (let index = 0; index < 30; index++) {
        await quickTicket(fresh.database)
      }
      const results = await Promise.all(
        Array.from({ length: 12 }, () => claimAttempts(fresh.database, 4)),
      )
      const ids = results.flat().map((context) => context.attempt.id)
      assert.equal(ids.length, 30)
      assert.equal(new Set(ids).size, 30)
      const tickets = results.flat().map((context) => context.ticket.id)
      assert.equal(new Set(tickets).size, 30)
    } finally {
      await fresh.close()
    }
  })

  test('claims racing cancellations neither deadlock nor leak attempts', async () => {
    const fresh = await createTestStore()
    try {
      const tickets = []
      for (let index = 0; index < 20; index++) {
        tickets.push(await quickTicket(fresh.database))
      }
      const results = await Promise.allSettled([
        ...tickets.map((ticket) =>
          cancelTicket(fresh.database, { ticketNumber: ticket.number }),
        ),
        ...Array.from({ length: 5 }, () => claimAttempts(fresh.database, 5)),
      ])
      assert.deepEqual(
        results.filter((result) => result.status === 'rejected'),
        [],
      )
      const statuses = await listTickets(fresh.database)
      assert.ok(statuses.every((ticket) => ticket.status === 'cancelled'))
    } finally {
      await fresh.close()
    }
  })

  test('a ticket never has two open attempts', async () => {
    const { id } = await quickTicket(database)
    await assert.rejects(
      database.query(
        "INSERT INTO attempts (ticket_id, step_id, status) VALUES ($1, 'build', 'pending')",
        [id],
      ),
      /attempts_one_open_per_ticket/,
    )
  })

  test('only a claimed pending attempt starts running', async () => {
    const { number, id } = await quickTicket(database)
    const [attempt] = await listAttempts(database, id)
    assert.ok(attempt)
    await assertFactoryError(
      markRunning(database, attempt.id, 'codex'),
      'conflict',
      /has not been claimed/,
    )
    const attemptId = await start(database, number)
    await assertFactoryError(
      markRunning(database, attemptId, 'codex'),
      'conflict',
      /running, not pending/,
    )
  })

  test('a completion racing a cancellation is serialised', async () => {
    for (let round = 0; round < 10; round++) {
      const { number, id } = await quickTicket(database)
      const attemptId = await start(database, number)
      const [completed, cancelled] = await Promise.allSettled([
        completeAttempt(database, attemptId, { outcome: 'done', summary: 'x' }),
        cancelTicket(database, { ticketNumber: number }),
      ])
      // Either the completion lands first and the cancel stops the next step,
      // or the cancel lands first and the late completion is refused.
      assert.equal(cancelled.status, 'fulfilled')
      if (completed.status === 'rejected') {
        assert.match(String(completed.reason), /no longer open/)
      }
      assert.equal((await getTicket(database, number))?.status, 'cancelled')
      const open = (await listAttempts(database, id)).filter((attempt) =>
        ['pending', 'running', 'waiting'].includes(attempt.status),
      )
      assert.deepEqual(open, [])
    }
  })

  test('two people approving at once: one wins, the other is told it moved on', async () => {
    const { number } = await quickTicket(database)
    await finish(database, number, 'done')
    const attemptId = await waitingId(database, number)
    const results = await Promise.allSettled([
      decide(database, { ticketNumber: number, attemptId, choice: 'approved' }),
      decide(database, { ticketNumber: number, attemptId, choice: 'rejected' }),
    ])
    assert.deepEqual(results.map((result) => result.status).sort(), [
      'fulfilled',
      'rejected',
    ])
  })
})

describe('interrupting at startup', () => {
  test('retries once, then asks; releases claims that never started', async () => {
    const fresh = await createTestStore()
    try {
      const running = await quickTicket(fresh.database)
      const claimedOnly = await quickTicket(fresh.database)
      await start(fresh.database, running.number)
      const [claimed] = await claimAttempts(fresh.database, 1)
      assert.equal(claimed?.ticket.number, claimedOnly.number)

      const first = await interruptRunning(fresh.database)
      assert.deepEqual(first.released, [claimed.attempt.id])
      assert.deepEqual(
        first.interrupted.map(({ ticketNumber, then }) => [ticketNumber, then]),
        [[running.number, 'retry']],
      )
      assert.equal(
        (await getTicket(fresh.database, running.number))?.status,
        'queued',
      )

      await start(fresh.database, running.number)
      const second = await interruptRunning(fresh.database)
      assert.deepEqual(
        second.interrupted.map(({ then }) => then),
        ['ask'],
      )
      const ticket = await getTicket(fresh.database, running.number)
      assert.equal(ticket?.waiting?.askReason, 'interrupted')

      const attempts = await listAttempts(fresh.database, running.id)
      assert.deepEqual(
        attempts.map((attempt) => attempt.status),
        ['interrupted', 'interrupted', 'waiting'],
      )
    } finally {
      await fresh.close()
    }
  })
})

describe('listing', () => {
  test('filters by status and says what a ticket waits for', async () => {
    const fresh = await createTestStore()
    try {
      const queued = await quickTicket(fresh.database)
      const waiting = await quickTicket(fresh.database)
      await finish(fresh.database, waiting.number, 'done')
      const needsYou = await listTickets(fresh.database, {
        status: ['needs-you'],
      })
      assert.deepEqual(
        needsYou.map((ticket) => ticket.number),
        [waiting.number],
      )
      assert.equal(needsYou[0]?.waiting?.stepId, 'approve-plan')
      const all = await listTickets(fresh.database)
      assert.deepEqual(
        all.map((ticket) => ticket.number),
        [waiting.number, queued.number],
      )
    } finally {
      await fresh.close()
    }
  })
})

describe('events', () => {
  test('are append-only', async () => {
    await quickTicket(database)
    await assert.rejects(
      database.query("UPDATE events SET kind = 'x'"),
      /append-only/,
    )
    await assert.rejects(database.query('DELETE FROM events'), /append-only/)
    await assert.rejects(database.query('TRUNCATE events'), /append-only/)
  })

  test('wake listeners when recorded', async () => {
    const signal = listenForEvents(database)
    try {
      await signal.ready
      const woken = new Promise<void>((resolve) => {
        const unsubscribe = signal.subscribe(() => {
          unsubscribe()
          resolve()
        })
      })
      await quickTicket(database)
      await woken
    } finally {
      await signal.close()
    }
  })
})
