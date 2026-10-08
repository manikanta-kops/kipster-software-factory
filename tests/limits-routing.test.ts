import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  afterResult,
  runsOf,
  sendBacksOf,
  type AttemptState,
} from '../src/domain/lifecycle.ts'
import { afterParallelResults } from '../src/domain/parallel-final.ts'
import { nextStep } from '../src/domain/routing.ts'
import { builtInWorkflow } from './helpers/store.ts'

function history(
  stepId: string,
  outcomes: readonly (string | null)[],
): AttemptState[] {
  return [
    ...outcomes.map((outcome): AttemptState => ({
      stepId,
      status: 'finished',
      outcome,
      waitingFor: null,
      next: null,
    })),
    { stepId, status: 'running', outcome: null, waitingFor: null, next: null },
  ]
}
const fail = {
  outcome: 'changes-needed',
  summary: 'Needs correction',
  artifacts: [],
}
const pass = { ...fail, outcome: 'passed' }

test('ticket 56: two passing final tests do not consume the first changes-needed send-back', async () => {
  const workflow = (await builtInWorkflow('lead')).workflow
  const attempts = history('final-test', ['passed', 'passed'])
  assert.equal(runsOf(attempts, 'final-test'), 2)
  assert.equal(sendBacksOf(attempts, 'final-test', 'changes-needed'), 0)
  assert.deepEqual(afterResult(workflow, attempts, fail).close.next, {
    to: 'step',
    stepId: 'lead',
  })
})

test('only matching finished outcomes count; crashes, interruptions and owner resolutions do not', async () => {
  const workflow = (await builtInWorkflow('lead')).workflow
  const attempts: AttemptState[] = [
    ...history('final-test', ['changes-needed', 'passed', null]).slice(0, -1),
    {
      stepId: 'final-test',
      status: 'failed',
      outcome: null,
      waitingFor: null,
      next: null,
    },
    {
      stepId: 'final-test',
      status: 'interrupted',
      outcome: null,
      waitingFor: null,
      next: null,
    },
    {
      stepId: 'final-test',
      status: 'finished',
      outcome: 'changes-needed',
      waitingFor: 'ask',
      next: null,
    },
    ...history('review', ['changes-needed']).slice(0, -1),
    ...history('final-test', []),
  ]
  assert.equal(sendBacksOf(attempts, 'final-test', fail.outcome), 1)
  assert.deepEqual(afterResult(workflow, attempts, fail).close.next, {
    to: 'step',
    stepId: 'lead',
  })
})

for (const [stepId, limit, target] of [
  ['final-test', 3, 'ask'],
  ['review', 5, 'maintain-pr'],
] as const) {
  test(`${stepId} reaches the limit on exactly ${limit} matching send-backs, with passes interleaved`, async () => {
    const workflow = (await builtInWorkflow('lead')).workflow
    for (let round = 1; round <= limit; round++) {
      const outcomes = Array.from({ length: round - 1 }, () => [
        'changes-needed',
        'passed',
      ]).flat()
      const transition = afterResult(workflow, history(stepId, outcomes), fail)
      assert.deepEqual(
        transition.close.next,
        round < limit
          ? { to: 'step', stepId: 'lead' }
          : target === 'ask'
            ? { to: 'ask', because: 'limit' }
            : { to: 'step', stepId: target },
      )
    }
  })
}

for (const name of ['lead', 'bug', 'onboard-repo', 'task-pr']) {
  test(`${name}: maintenance separately bounds ci-failed/conflict and exempts base-moved`, async () => {
    const workflow = (await builtInWorkflow(name)).workflow
    const step = workflow.steps.find((s) => s.id === 'maintain-pr')!
    assert.equal(step.limit, 3)
    for (const outcome of ['ci-failed', 'conflict']) {
      const other = outcome === 'ci-failed' ? 'conflict' : 'ci-failed'
      assert.deepEqual(
        afterResult(
          workflow,
          history(step.id, [other, other, 'ready', 'base-moved']),
          { outcome, summary: 'Failure' },
        ).close.next,
        { to: 'step', stepId: step.routes[outcome] },
      )
      assert.deepEqual(
        afterResult(
          workflow,
          history(step.id, [outcome, other, outcome, 'ready']),
          { outcome, summary: 'Failure' },
        ).close.next,
        name === 'task-pr' ? { to: 'cancel' } : { to: 'ask', because: 'limit' },
      )
    }
    const next = nextStep(workflow, step.id, 'base-moved', 100)
    assert.deepEqual(
      next,
      step.routes['base-moved']
        ? { to: 'step', stepId: step.routes['base-moved'] }
        : { to: 'ask', because: 'unrouted' },
    )
    assert.deepEqual(nextStep(workflow, step.id, 'ready', 100), {
      to: 'step',
      stepId: 'merge',
    })
  })
}

for (const survivor of ['tester', 'reviewer'] as const) {
  test(`paired ${survivor} changes-needed survives sibling crash and preserves its own limit`, async () => {
    const workflow = (await builtInWorkflow('lead')).workflow
    const transition = afterParallelResults(
      workflow,
      history('final-test', ['passed', 'passed']),
      history('review', ['passed', 'passed']),
      survivor === 'tester' ? fail : null,
      survivor === 'reviewer' ? fail : null,
      'Sibling crashed',
    )
    assert.deepEqual(transition.close.next, { to: 'step', stepId: 'lead' })
    assert.equal(
      transition.close.status,
      survivor === 'tester' ? 'finished' : 'failed',
    )
    assert.equal(
      transition.close.outcome,
      survivor === 'tester' ? 'changes-needed' : null,
    )
    const exhausted = afterParallelResults(
      workflow,
      history('final-test', ['changes-needed', 'changes-needed']),
      history('review', Array(4).fill('changes-needed')),
      survivor === 'tester' ? fail : null,
      survivor === 'reviewer' ? fail : null,
      'Sibling crashed',
    )
    assert.deepEqual(
      exhausted.close.next,
      survivor === 'tester'
        ? { to: 'ask', because: 'limit' }
        : { to: 'step', stepId: 'maintain-pr' },
    )
  })
}

test('paired crash with a passing or missing survivor still asks the owner', async () => {
  const workflow = (await builtInWorkflow('lead')).workflow
  for (const [tester, reviewer] of [
    [null, pass],
    [pass, null],
    [null, null],
  ] as const) {
    const transition = afterParallelResults(
      workflow,
      history('final-test', []),
      history('review', []),
      tester,
      reviewer,
      'Sibling crashed',
    )
    assert.deepEqual(transition.close.next, null)
    assert.equal(transition.open?.askReason, 'failed')
  }
})
