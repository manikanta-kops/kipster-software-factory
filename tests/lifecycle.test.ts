import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { FactoryError } from '../src/domain/errors.ts'
import {
  afterCancel,
  afterDecision,
  afterFailure,
  afterInterruption,
  afterPullRequestBaseAdvance,
  afterResolution,
  afterResult,
  type AttemptState,
  branchName,
  checkCapabilities,
  parseStepResult,
  runsOf,
  startAttempt,
  startTicket,
  ticketStatus,
  waitForMerge,
} from '../src/domain/lifecycle.ts'
import type { Next } from '../src/domain/routing.ts'
import { parseWorkflow, type Workflow } from '../src/domain/workflow.ts'

function load(source: string): Workflow {
  const result = parseWorkflow(source)
  if (!result.ok) throw new Error(result.errors.join('\n'))
  return result.workflow
}

const quick = load(
  readFileSync(
    new URL('./fixtures/workflows/planned-change.yml', import.meta.url),
    'utf8',
  ),
)
const tested = load(
  readFileSync(
    new URL('./fixtures/workflows/tested-change.yml', import.meta.url),
    'utf8',
  ),
)

function attempt(
  stepId: string,
  status: AttemptState['status'],
  extra: Partial<AttemptState> = {},
): AttemptState {
  return { stepId, status, waitingFor: null, next: null, ...extra }
}

const finished = (stepId: string, next: Next) =>
  attempt(stepId, 'finished', { next })
const humanWaiting = (stepId: string) =>
  attempt(stepId, 'waiting', { waitingFor: 'human' })
const askWaiting = (stepId: string) =>
  attempt(stepId, 'waiting', { waitingFor: 'ask' })

function rejects(work: () => unknown, code: string, pattern: RegExp) {
  assert.throws(work, (error: unknown) => {
    assert.ok(error instanceof FactoryError)
    assert.equal(error.code, code)
    assert.match(error.message, pattern)
    return true
  })
}

describe('starting a ticket', () => {
  test('queues an attempt for the first step', () => {
    assert.deepEqual(startTicket(quick), {
      stepId: 'plan',
      status: 'pending',
      waitingFor: null,
      askReason: null,
      summary: null,
    })
  })

  test('a human first step waits for you', () => {
    const workflow = load(`
name: approve-first
description: Starts with you.
steps:
  - id: approve
    kind: human
  - id: build
    kind: agent
    role: builder
`)
    assert.deepEqual(startTicket(workflow), {
      stepId: 'approve',
      status: 'waiting',
      waitingFor: 'human',
      askReason: null,
      summary: null,
    })
  })

  test('a claimed attempt starts running', () => {
    assert.equal(startAttempt([attempt('plan', 'pending')]), 'running')
    rejects(
      () => startAttempt([attempt('plan', 'running')]),
      'conflict',
      /running, not pending/,
    )
  })
})

describe('a finished agent or system attempt', () => {
  test('routed to a step opens a pending attempt there', () => {
    const transition = afterResult(quick, [attempt('build', 'running')], {
      outcome: 'done',
      summary: 'Built it',
    })
    assert.deepEqual(transition, {
      close: {
        status: 'finished',
        outcome: 'done',
        next: { to: 'step', stepId: 'review' },
      },
      open: {
        stepId: 'review',
        status: 'pending',
        waitingFor: null,
        askReason: null,
        summary: null,
      },
      status: 'queued',
    })
  })

  test('routed to a human step opens a waiting attempt with the human choices', () => {
    const transition = afterResult(quick, [attempt('plan', 'running')], {
      outcome: 'done',
      summary: 'Planned',
    })
    assert.deepEqual(transition.open, {
      stepId: 'approve-plan',
      status: 'waiting',
      waitingFor: 'human',
      askReason: null,
      summary: null,
    })
    assert.equal(transition.status, 'needs-you')
  })

  test('finish ends the ticket as done', () => {
    const transition = afterResult(quick, [attempt('merge', 'running')], {
      outcome: 'merged',
      summary: 'Merged',
    })
    assert.deepEqual(transition.close.next, { to: 'finish' })
    assert.equal(transition.open, null)
    assert.equal(transition.status, 'done')
  })

  test('cancel ends the ticket as cancelled', () => {
    const transition = afterResult(quick, [attempt('merge', 'running')], {
      outcome: 'rejected',
      summary: 'Policy forbids it',
    })
    assert.deepEqual(transition.close.next, { to: 'cancel' })
    assert.equal(transition.open, null)
    assert.equal(transition.status, 'cancelled')
  })

  test('an unrouted outcome asks you at that step', () => {
    const transition = afterResult(quick, [attempt('build', 'running')], {
      outcome: 'needs-other-repo',
      summary: 'Needs the API repository',
    })
    assert.deepEqual(transition.close.next, { to: 'ask', because: 'unrouted' })
    assert.deepEqual(transition.open, {
      stepId: 'build',
      status: 'waiting',
      waitingFor: 'ask',
      askReason: 'unrouted',
      summary:
        'build reported needs-other-repo, which has no route in this workflow.',
    })
    assert.equal(transition.status, 'needs-you')
  })

  test('needs-decision asks you with the step summary', () => {
    const transition = afterResult(quick, [attempt('plan', 'running')], {
      outcome: 'needs-decision',
      summary: 'Should the button be blue or green?',
    })
    assert.equal(transition.open?.askReason, 'needs-decision')
    assert.equal(
      transition.open?.summary,
      'plan needs a decision: Should the button be blue or green?',
    )
  })

  test('an outcome routed to ask asks you', () => {
    const workflow = load(`
name: routed
description: Sends conflicts to you.
steps:
  - id: maintain-pr
    kind: system
    action: maintain-pr
    routes:
      conflict: ask
`)
    const transition = afterResult(
      workflow,
      [attempt('maintain-pr', 'running')],
      {
        outcome: 'conflict',
        summary: 'Conflicts in package.json',
      },
    )
    assert.equal(transition.open?.askReason, 'routed')
    assert.equal(transition.open?.stepId, 'maintain-pr')
  })

  test('maintain-pr conflict and ci-failed go back to build', () => {
    for (const outcome of ['conflict', 'ci-failed']) {
      const transition = afterResult(
        quick,
        [attempt('maintain-pr', 'running')],
        { outcome, summary: outcome },
      )
      assert.deepEqual(transition.close.next, { to: 'step', stepId: 'build' })
    }
  })

  test('a step may not report outcomes outside its role', () => {
    rejects(
      () =>
        afterResult(quick, [attempt('build', 'running')], {
          outcome: 'passed',
          summary: 'x',
        }),
      'invalid',
      /cannot report "passed"; it can report done, needs-other-repo, needs-decision/,
    )
    rejects(
      () =>
        afterResult(quick, [attempt('review', 'running')], {
          outcome: 'limit',
          summary: 'x',
        }),
      'invalid',
      /cannot report "limit"/,
    )
  })

  test('only a running attempt, or one waiting for its merge, can finish', () => {
    rejects(
      () =>
        afterResult(quick, [attempt('build', 'pending')], {
          outcome: 'done',
          summary: 'x',
        }),
      'conflict',
      /pending, not running/,
    )
    const merged = afterResult(
      quick,
      [attempt('merge', 'waiting', { waitingFor: 'pull-request-merge' })],
      { outcome: 'merged', summary: 'Merged' },
    )
    assert.equal(merged.status, 'done')
  })

  test('human steps finish only with a decision', () => {
    rejects(
      () =>
        afterResult(quick, [humanWaiting('approve-plan')], {
          outcome: 'approved',
          summary: 'x',
        }),
      'conflict',
      /finishes with a decision/,
    )
  })

  test('nothing finishes on a ticket that has ended', () => {
    rejects(
      () =>
        afterResult(quick, [finished('merge', { to: 'finish' })], {
          outcome: 'merged',
          summary: 'x',
        }),
      'conflict',
      /already ended/,
    )
  })
})

describe('limits', () => {
  test('runs count finished attempts of the step', () => {
    const history = [
      finished('review', { to: 'step', stepId: 'build' }),
      attempt('review', 'interrupted'),
      attempt('review', 'failed'),
      attempt('review', 'finished', {
        waitingFor: 'ask',
        next: { to: 'step', stepId: 'review' },
      }),
      finished('build', { to: 'step', stepId: 'review' }),
      attempt('review', 'running'),
    ]
    assert.equal(runsOf(history, 'review'), 1)
    assert.equal(runsOf(history, 'build'), 1)
  })

  test('review sends back until its limit of 2, then asks', () => {
    const first = afterResult(quick, [attempt('review', 'running')], {
      outcome: 'changes-needed',
      summary: 'Missing test',
    })
    assert.deepEqual(first.close.next, { to: 'step', stepId: 'build' })

    const second = afterResult(
      quick,
      [
        finished('review', { to: 'step', stepId: 'build' }),
        finished('build', { to: 'step', stepId: 'review' }),
        attempt('review', 'running'),
      ],
      { outcome: 'changes-needed', summary: 'Still missing' },
    )
    assert.deepEqual(second.close.next, { to: 'ask', because: 'limit' })
    assert.deepEqual(second.open, {
      stepId: 'review',
      status: 'waiting',
      waitingFor: 'ask',
      askReason: 'limit',
      summary:
        'review reported changes-needed after 2 runs, reaching its limit of 2.',
    })
  })

  test('interrupted attempts do not use up the limit', () => {
    const transition = afterResult(
      quick,
      [
        attempt('review', 'interrupted'),
        attempt('review', 'interrupted'),
        attempt('review', 'running'),
      ],
      { outcome: 'changes-needed', summary: 'x' },
    )
    assert.deepEqual(transition.close.next, { to: 'step', stepId: 'build' })
  })
})

describe('human steps', () => {
  const waiting = [
    finished('plan', { to: 'step', stepId: 'approve-plan' }),
    humanWaiting('approve-plan'),
  ]

  test('approved continues', () => {
    const transition = afterDecision(quick, waiting, { choice: 'approved' })
    assert.deepEqual(transition.close, {
      status: 'finished',
      outcome: 'approved',
      next: { to: 'step', stepId: 'build' },
    })
    assert.equal(transition.status, 'queued')
  })

  test('changes-needed goes back to plan and requires a comment', () => {
    rejects(
      () => afterDecision(quick, waiting, { choice: 'changes-needed' }),
      'invalid',
      /requires a comment/,
    )
    rejects(
      () =>
        afterDecision(quick, waiting, {
          choice: 'changes-needed',
          comment: '   ',
        }),
      'invalid',
      /requires a comment/,
    )
    const transition = afterDecision(quick, waiting, {
      choice: 'changes-needed',
      comment: 'Cover the empty state',
    })
    assert.deepEqual(transition.close.next, { to: 'step', stepId: 'plan' })
    assert.equal(transition.open?.status, 'pending')
  })

  test('rejected cancels', () => {
    const transition = afterDecision(quick, waiting, { choice: 'rejected' })
    assert.deepEqual(transition.close.next, { to: 'cancel' })
    assert.equal(transition.status, 'cancelled')
  })

  test('a decision needs a step waiting for one', () => {
    rejects(
      () => afterDecision(quick, [askWaiting('build')], { choice: 'approved' }),
      'conflict',
      /not waiting for a decision/,
    )
  })
})

describe('resolving an ask', () => {
  const asked = [
    finished('build', { to: 'ask', because: 'unrouted' }),
    askWaiting('build'),
  ]

  test('retry runs the same step again', () => {
    const transition = afterResolution(quick, asked, { action: 'retry' })
    assert.deepEqual(transition.close, {
      status: 'finished',
      outcome: null,
      next: { to: 'step', stepId: 'build' },
    })
    assert.equal(transition.open?.stepId, 'build')
    assert.equal(transition.open?.status, 'pending')
  })

  test('move goes to any step, including a human one', () => {
    const transition = afterResolution(quick, asked, {
      action: 'move',
      stepId: 'approve-plan',
    })
    assert.deepEqual(transition.close.next, {
      to: 'step',
      stepId: 'approve-plan',
    })
    assert.equal(transition.open?.waitingFor, 'human')
    assert.equal(transition.status, 'needs-you')
  })

  test('move rejects unknown steps', () => {
    rejects(
      () => afterResolution(quick, asked, { action: 'move', stepId: 'deploy' }),
      'invalid',
      /no step "deploy"; its steps are plan, approve-plan/,
    )
  })

  test('cancel ends the ticket', () => {
    const transition = afterResolution(quick, asked, { action: 'cancel' })
    assert.deepEqual(transition.close.next, { to: 'cancel' })
    assert.equal(transition.open, null)
    assert.equal(transition.status, 'cancelled')
  })

  test('only an ask can be resolved', () => {
    rejects(
      () =>
        afterResolution(quick, [humanWaiting('approve-plan')], {
          action: 'retry',
        }),
      'conflict',
      /not waiting on an ask/,
    )
  })
})

describe('failures and interruptions', () => {
  test('a failed attempt asks you', () => {
    const transition = afterFailure(
      [attempt('build', 'running')],
      'claude exited with code 1',
    )
    assert.deepEqual(transition.close, {
      status: 'failed',
      outcome: null,
      next: null,
    })
    assert.deepEqual(transition.open, {
      stepId: 'build',
      status: 'waiting',
      waitingFor: 'ask',
      askReason: 'failed',
      summary: 'build failed: claude exited with code 1',
    })
  })

  test('the first interruption retries the step', () => {
    const transition = afterInterruption([
      finished('plan', { to: 'step', stepId: 'build' }),
      attempt('build', 'running'),
    ])
    assert.equal(transition.close.status, 'interrupted')
    assert.equal(transition.open?.status, 'pending')
    assert.equal(transition.open?.stepId, 'build')
    assert.equal(transition.status, 'queued')
  })

  test('a second interruption in a row asks you', () => {
    const transition = afterInterruption([
      attempt('build', 'interrupted'),
      attempt('build', 'running'),
    ])
    assert.equal(transition.open?.waitingFor, 'ask')
    assert.equal(transition.open?.askReason, 'interrupted')
    assert.equal(transition.status, 'needs-you')
  })

  test('after you retry, the next interruption retries again', () => {
    const transition = afterInterruption([
      attempt('build', 'interrupted'),
      attempt('build', 'interrupted'),
      attempt('build', 'finished', {
        waitingFor: 'ask',
        next: { to: 'step', stepId: 'build' },
      }),
      attempt('build', 'running'),
    ])
    assert.equal(transition.open?.status, 'pending')
  })

  test('only running attempts are interrupted', () => {
    rejects(
      () => afterInterruption([humanWaiting('approve-plan')]),
      'conflict',
      /not running/,
    )
  })
})

describe('cancelling and waiting for a merge', () => {
  test('cancel stops whatever is open', () => {
    for (const open of [
      attempt('build', 'pending'),
      attempt('build', 'running'),
      humanWaiting('approve-plan'),
      askWaiting('build'),
    ]) {
      const transition = afterCancel([open])
      assert.deepEqual(transition.close, {
        status: 'interrupted',
        outcome: null,
        next: { to: 'cancel' },
      })
      assert.equal(transition.status, 'cancelled')
    }
  })

  test('an ended ticket cannot be cancelled', () => {
    rejects(
      () => afterCancel([finished('merge', { to: 'finish' })]),
      'conflict',
      /already ended/,
    )
  })

  test('a running system step can wait for its pull request to merge', () => {
    assert.equal(
      waitForMerge(quick, [attempt('merge', 'running')]),
      'needs-you',
    )
    assert.equal(
      waitForMerge(quick, [attempt('merge', 'running')], 'pull-request-checks'),
      'running',
    )
    rejects(
      () => waitForMerge(quick, [attempt('build', 'running')]),
      'conflict',
      /Only system steps/,
    )
    rejects(
      () => waitForMerge(quick, [attempt('merge', 'pending')]),
      'conflict',
      /not running/,
    )
  })
})

describe('ticket status', () => {
  test('derives from the latest attempt', () => {
    assert.equal(ticketStatus(attempt('plan', 'pending')), 'queued')
    assert.equal(ticketStatus(attempt('plan', 'running')), 'running')
    assert.equal(ticketStatus(humanWaiting('approve-plan')), 'needs-you')
    assert.equal(ticketStatus(askWaiting('build')), 'needs-you')
    assert.equal(
      ticketStatus(
        attempt('merge', 'waiting', { waitingFor: 'pull-request-merge' }),
      ),
      'needs-you',
    )
    assert.equal(ticketStatus(finished('merge', { to: 'finish' })), 'done')
    assert.equal(
      ticketStatus(finished('approve-plan', { to: 'cancel' })),
      'cancelled',
    )
    assert.equal(
      ticketStatus(attempt('build', 'interrupted', { next: { to: 'cancel' } })),
      'cancelled',
    )
  })
})

describe('step results', () => {
  test('owner review is a typed, bounded reason on a passed result', () => {
    const result = parseStepResult({
      outcome: 'passed',
      summary: 'Correct',
      ownerReview: { reason: ' Changes public contract ' },
    })
    assert.deepEqual(result.ownerReview, { reason: 'Changes public contract' })
    for (const ownerReview of [
      true,
      'Owner please',
      {},
      { reason: ' ' },
      { reason: 'x'.repeat(1001) },
      { reason: 'Auth changes', extra: true },
    ])
      assert.throws(() =>
        parseStepResult({ outcome: 'passed', summary: 'Correct', ownerReview }),
      )
    assert.throws(() =>
      parseStepResult({
        outcome: 'changes-needed',
        summary: 'Wrong',
        ownerReview: { reason: 'Auth changes' },
      }),
    )
    assert.equal(
      parseStepResult({ outcome: 'passed', summary: 'Owner please' })
        .ownerReview,
      undefined,
    )
  })
  test('accepts content or path artifacts', () => {
    assert.deepEqual(
      parseStepResult({
        outcome: 'done',
        summary: 'Planned',
        artifacts: [
          { kind: 'plan', title: 'Plan', content: '# Plan' },
          { kind: 'log', title: 'Log', path: 'logs/1.txt' },
        ],
      }).artifacts.length,
      2,
    )
    assert.deepEqual(
      parseStepResult({ outcome: 'done', summary: 'x' }).artifacts,
      [],
    )
  })

  test('rejects artifacts with both or neither of content and path', () => {
    for (const artifact of [
      { kind: 'plan', title: 'Plan' },
      { kind: 'plan', title: 'Plan', content: 'x', path: 'y' },
    ]) {
      rejects(
        () =>
          parseStepResult({
            outcome: 'done',
            summary: 'x',
            artifacts: [artifact],
          }),
        'invalid',
        /artifacts\.0: give either content or path/,
      )
    }
  })

  test('rejects unknown kinds and missing summaries', () => {
    rejects(
      () =>
        parseStepResult({
          outcome: 'done',
          summary: 'x',
          artifacts: [{ kind: 'video', title: 'x', content: 'x' }],
        }),
      'invalid',
      /artifacts\.0\.kind/,
    )
    rejects(
      () => parseStepResult({ outcome: 'done', summary: ' ' }),
      'invalid',
      /summary/,
    )
  })
})

describe('capabilities', () => {
  const repository = { slug: 'acme/shop', capabilities: [] }

  test('planned-change needs nothing', () => {
    assert.doesNotThrow(() => checkCapabilities(quick, repository))
  })

  test('tested-change is rejected without verify, naming the steps', () => {
    rejects(
      () => checkCapabilities(tested, repository),
      'invalid',
      /Workflow "tested-change" needs capabilities that acme\/shop does not provide: verify \(needed by test\)/,
    )
    assert.doesNotThrow(() =>
      checkCapabilities(tested, {
        slug: 'acme/shop',
        capabilities: ['verify'],
      }),
    )
  })
})

test('base refresh cannot bypass human decisions, running work or workflows without maintenance', () => {
  for (const current of [
    humanWaiting('approve-plan'),
    askWaiting('maintain-pr'),
    attempt('maintain-pr', 'running'),
  ])
    rejects(
      () => afterPullRequestBaseAdvance(quick, [current]),
      'conflict',
      /not waiting for a pull request/,
    )
  rejects(
    () =>
      afterPullRequestBaseAdvance(quick, [
        attempt('merge', 'waiting', { waitingFor: 'pull-request-merge' }),
      ]),
    'conflict',
    /No prior pull request maintenance/,
  )
})

describe('branch names', () => {
  test('use the number and a slug of the title', () => {
    assert.equal(
      branchName(12, 'Fix the login redirect!'),
      'kipster/12-fix-the-login-redirect',
    )
    assert.equal(branchName(3, 'Café crème'), 'kipster/3-cafe-creme')
    assert.equal(branchName(4, '!!!'), 'kipster/4')
    assert.equal(
      branchName(5, 'a'.repeat(39) + ' tail that is cut'),
      `kipster/5-${'a'.repeat(39)}`,
    )
  })
})
