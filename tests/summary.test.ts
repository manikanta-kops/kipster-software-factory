import assert from 'node:assert/strict'
import { test } from 'node:test'
import { summarizeTicket } from '../src/domain/summary.ts'
import type {
  Artifact,
  Attempt,
  LeadTask,
  Ticket,
} from '../src/domain/records.ts'
import { evaluateMergeGate, type MergeFacts } from '../src/domain/merge-gate.ts'
import {
  builtInWorkflow,
  createTestStore,
  quickTicket,
} from './helpers/store.ts'
import {
  claimAttempts,
  markRunning,
  completeAttempt,
  getTicketDetail,
  resolveAsk,
  listTickets,
  failAttempt,
  decide,
  waitForPullRequestMerge,
  setPullRequestUrl,
} from '../src/store/tickets.ts'
import { saveMergeGate } from '../src/store/merge-gates.ts'

const start = '2026-10-06T00:00:00.000Z'
const end = '2026-10-06T06:12:00.000Z'
const head = 'a'.repeat(40)
const green: MergeFacts = {
  head,
  localHead: head,
  base: 'b'.repeat(40),
  behind: 0,
  tester: { status: 'finished', outcome: 'passed', commit: head },
  hasTester: true,
  reviewer: { status: 'finished', outcome: 'passed', commit: head },
  hasReviewer: true,
  reproducer: null,
  hasReproducer: false,
  ci: 'passed',
  checks: [],
  feedback: [],
  buildWork: false,
  state: 'OPEN',
  draft: false,
  mergeable: 'MERGEABLE',
  paths: [],
  migrationGlobs: [],
  trustedKitError: null,
  approvedUnverified: null,
}
const prose = 'AGENT PROSE MUST NOT APPEAR'
const ticket: Ticket = {
  summary: null,
  summaryAt: null,
  lightsOut: false,
  id: 1,
  number: 1,
  repository: { id: 1, slug: 'acme/app' },
  workflow: { name: 'lead', version: 'demo' },
  title: prose,
  body: prose,
  branch: 'kipster/1',
  pullRequestUrl: null,
  currentStep: 'merge',
  status: 'done',
  waiting: null,
  createdAt: start,
  updatedAt: end,
}
const attempt: Attempt = {
  id: 1,
  ticketId: 1,
  stepId: 'build',
  status: 'finished',
  outcome: 'done',
  summary: prose,
  error: prose,
  executor: 'codex',
  waitingFor: null,
  askReason: null,
  next: { to: 'finish' },
  createdAt: start,
  claimedAt: start,
  startedAt: start,
  waitingSince: null,
  headCommit: head,
  finishedAt: end,
}
const task: LeadTask = {
  id: 1,
  ticketId: 1,
  attemptId: 1,
  key: 'api',
  title: prose,
  instructions: prose,
  land: 'branch',
  workflow: 'task',
  agent: null,
  status: 'merged',
  decision: null,
  result: prose,
  baseCommit: head,
  child: null,
  createdAt: start,
  updatedAt: end,
}
const artifact: Artifact = {
  id: 1,
  ticketId: 1,
  attemptId: 1,
  stepId: 'build',
  kind: 'decision',
  title: prose,
  content: prose,
  path: null,
  mediaType: 'text/markdown',
  createdAt: end,
  decision: { chose: prose, alternative: prose, reason: prose },
}
async function facts(
  patch: Partial<Parameters<typeof summarizeTicket>[0]> = {},
) {
  return {
    ticket,
    attempts: [attempt],
    tasks: [],
    artifacts: [],
    workflow: (await builtInWorkflow('lead')).workflow,
    mergeGate: null,
    ...patch,
  }
}

test('done is ready with empty issues and facts-only activity', async () => {
  const summary = summarizeTicket(await facts())
  assert.equal(summary.status, 'ready')
  assert.equal(summary.happened, '1 step completed · 6h 12m')
  assert.deepEqual(summary.actions, [])
  assert.deepEqual(summary.issues, [])
  assert.deepEqual(summary.unverified, [])
})

test('human and parked child actions are counted and linked', async () => {
  const waiting = {
    attemptId: 2,
    stepId: 'approve-plan',
    for: 'human' as const,
    askReason: null,
    summary: prose,
    since: end,
  }
  const child = {
    id: 2,
    number: 8,
    status: 'needs-you' as const,
    branch: 'child',
    currentStep: 'build',
    pullRequestUrl: null,
    waiting: null,
  }
  const summary = summarizeTicket(
    await facts({
      ticket: { ...ticket, status: 'needs-you', waiting },
      tasks: [{ ...task, status: 'parked', child }],
    }),
  )
  assert.equal(summary.status, 'needs-you')
  assert.equal(summary.needsYouCount, 2)
  assert.deepEqual(
    summary.actions.map((a) => a.href),
    ['#/tickets/1', '#/tickets/8'],
  )
})

for (const reason of ['failed', 'limit', 'interrupted', 'unrouted'] as const)
  test(`${reason} ask is blocked and never copies its explanation`, async () => {
    const summary = summarizeTicket(
      await facts({
        ticket: {
          ...ticket,
          status: 'needs-you',
          waiting: {
            attemptId: 2,
            stepId: 'build',
            for: 'ask',
            askReason: reason,
            summary: prose,
            since: end,
          },
        },
      }),
    )
    assert.equal(summary.status, 'blocked')
    assert.match(summary.issues.join(), new RegExp(reason))
    assert.ok(!JSON.stringify(summary).includes(prose))
  })

test('a clean owner merge is ready; gate blockers and owner flags stay visible', async () => {
  const waiting = {
    attemptId: 2,
    stepId: 'merge',
    for: 'pull-request-merge' as const,
    askReason: null,
    summary: prose,
    since: end,
  }
  const input = await facts({
    ticket: {
      ...ticket,
      status: 'needs-you',
      pullRequestUrl: 'https://github.com/acme/app/pull/1',
      waiting,
    },
    mergeGate: evaluateMergeGate(green, end),
  })
  assert.equal(summarizeTicket(input).status, 'ready')
  assert.equal(
    summarizeTicket(input).actions[0]!.href,
    input.ticket.pullRequestUrl,
  )
  const blocked = summarizeTicket({
    ...input,
    mergeGate: evaluateMergeGate({ ...green, ci: 'failed' }, end),
  })
  assert.equal(blocked.status, 'blocked')
  assert.ok(blocked.issues.includes('CI failed'))
  const flagged = summarizeTicket({
    ...input,
    mergeGate: evaluateMergeGate(
      {
        ...green,
        reviewer: { ...green.reviewer!, ownerReview: { reason: prose } },
      },
      end,
    ),
  })
  assert.equal(flagged.status, 'needs-you')
  assert.equal(flagged.needsYouCount, 2)
  assert.ok(!JSON.stringify(flagged).includes(prose))
})

test('a later observed commit prevents a stored green gate from reporting ready', async () => {
  const input = await facts({
    ticket: {
      ...ticket,
      status: 'needs-you',
      pullRequestUrl: 'https://github.com/acme/app/pull/1',
      waiting: {
        attemptId: 2,
        stepId: 'merge',
        for: 'pull-request-merge',
        askReason: null,
        summary: prose,
        since: end,
      },
    },
    attempts: [{ ...attempt, headCommit: 'c'.repeat(40) }],
    mergeGate: evaluateMergeGate(green, start),
  })
  const summary = summarizeTicket(input)
  assert.equal(summary.status, 'blocked')
  assert.ok(summary.issues.includes('Ticket branch differs from the PR head'))
})

test('untested work, scenarios, decisions, retries and task failures use structured facts only', async () => {
  const summary = summarizeTicket(
    await facts({
      ticket: {
        ...ticket,
        skippedSteps: [{ stepId: 'test', missingCapabilities: ['verify'] }],
      },
      attempts: [
        { ...attempt, status: 'interrupted', outcome: null },
        { ...attempt, id: 2 },
        { ...attempt, id: 3, stepId: 'final-test', outcome: 'passed' },
      ],
      tasks: [
        task,
        { ...task, id: 2, key: 'db', status: 'conflict' },
        { ...task, id: 3, key: 'docs' },
      ],
      artifacts: [
        artifact,
        {
          ...artifact,
          id: 2,
          attemptId: 3,
          kind: 'evidence',
          stepId: 'final-test',
          scenario: prose,
          scenarioResult: 'unverified',
          decision: null,
        },
      ],
    }),
  )
  assert.equal(summary.status, 'blocked')
  assert.match(
    summary.happened,
    /2 tasks merged.*1 conflict.*1 retry.*1 decision recorded.*6h 12m/,
  )
  assert.deepEqual(summary.unverified, [
    'Untested: no verify capability (skipped test)',
    '1 item the checker could not verify',
    '1 scenario unverified at the current commit',
  ])
  assert.ok(summary.issues.includes('Task db: conflict'))
  assert.ok(!JSON.stringify(summary).includes(prose))
})

test('cancelled is blocked, routed decisions need the owner and left-open tasks link to PRs', async () => {
  assert.equal(
    summarizeTicket(await facts({ ticket: { ...ticket, status: 'cancelled' } }))
      .status,
    'blocked',
  )
  const summary = summarizeTicket(
    await facts({
      ticket: {
        ...ticket,
        status: 'needs-you',
        waiting: {
          attemptId: 2,
          stepId: 'build',
          for: 'ask',
          askReason: 'needs-decision',
          summary: prose,
          since: end,
        },
      },
      tasks: [
        {
          ...task,
          status: 'left-open',
          child: {
            id: 8,
            number: 8,
            status: 'needs-you',
            branch: 'child',
            currentStep: 'merge',
            pullRequestUrl: 'https://github.com/acme/app/pull/8',
            waiting: null,
          },
        },
      ],
    }),
  )
  assert.equal(summary.status, 'needs-you')
  assert.equal(summary.needsYouCount, 2)
  assert.equal(summary.actions[1]!.href, 'https://github.com/acme/app/pull/8')
})

test('PostgreSQL lifecycle writes on parks, rewrites on completion, and leaves old tickets null', async () => {
  const store = await createTestStore()
  const db = store.database
  try {
    const created = await quickTicket(db)
    assert.equal(created.summary, null)
    const old = await getTicketDetail(db, created.number)
    assert.equal(old!.ticket.summary, null)
    async function run(outcome?: string) {
      const context = (await claimAttempts(db, 1))[0]!
      await markRunning(db, context.attempt.id, 'codex')
      if (outcome)
        await completeAttempt(db, context.attempt.id, {
          outcome,
          summary: prose,
          artifacts: [],
        })
      return context.attempt.id
    }
    await run('done')
    const parked = (await getTicketDetail(db, created.number))!
    assert.equal(parked.ticket.summary!.status, 'needs-you')
    assert.ok(parked.ticket.summaryAt)
    assert.equal((await listTickets(db))[0]!.summary!.needsYouCount, 1)
    assert.ok(parked.events.some((event) => event.kind === 'ticket.summary'))
    await decide(db, {
      ticketNumber: created.number,
      attemptId: parked.ticket.waiting!.attemptId,
      choice: 'approved',
    })
    const failedId = await run()
    await failAttempt(db, failedId, prose)
    const failed = (await getTicketDetail(db, created.number))!
    assert.equal(failed.ticket.summary!.status, 'blocked')
    await resolveAsk(db, {
      ticketNumber: created.number,
      attemptId: failed.ticket.waiting!.attemptId,
      resolution: { action: 'retry' },
    })
    await run('done')
    await run('passed')
    await run('ready')
    const mergeId = await run()
    await setPullRequestUrl(
      db,
      created.id,
      'https://github.com/acme/app/pull/1',
    )
    await waitForPullRequestMerge(db, mergeId)
    await saveMergeGate(db, created.id, evaluateMergeGate(green, end))
    assert.equal(
      (await getTicketDetail(db, created.number))!.ticket.summary!.status,
      'ready',
    )
    await saveMergeGate(
      db,
      created.id,
      evaluateMergeGate({ ...green, ci: 'failed' }, end),
    )
    assert.equal(
      (await getTicketDetail(db, created.number))!.ticket.summary!.status,
      'blocked',
    )
    await completeAttempt(db, mergeId, {
      outcome: 'merged',
      summary: prose,
      artifacts: [],
    })
    const done = (await getTicketDetail(db, created.number))!
    assert.equal(done.ticket.summary!.status, 'ready')
    assert.notDeepEqual(done.ticket.summary, parked.ticket.summary)
    assert.ok(!JSON.stringify(done.ticket.summary).includes(prose))
    assert.deepEqual(done.ticket.summary!.issues, [])
  } finally {
    await store.close()
  }
})
