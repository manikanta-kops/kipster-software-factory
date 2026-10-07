import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { describeRoutes, firstStep, nextStep } from '../src/domain/routing.ts'
import { parseWorkflow, type Workflow } from '../src/domain/workflow.ts'

function load(source: string): Workflow {
  const result = parseWorkflow(source)
  if (!result.ok) throw new Error(result.errors.join('\n'))
  return result.workflow
}

const planned = load(`
name: planned-change
description: Plan, build, test and merge.
steps:
  - id: plan
    kind: agent
    role: planner
  - id: approve
    kind: human
    routes:
      changes-needed: plan
  - id: build
    kind: agent
    role: builder
  - id: test
    kind: agent
    role: tester
    limit: 2
    routes:
      changes-needed: build
  - id: merge
    kind: system
    action: merge
    routes:
      changes-needed: build
`)

describe('nextStep', () => {
  test('starts at the first step', () => {
    assert.equal(firstStep(planned).id, 'plan')
  })

  test('a success outcome continues to the next step', () => {
    assert.deepEqual(nextStep(planned, 'plan', 'done', 1), {
      to: 'step',
      stepId: 'approve',
    })
  })

  test('success on the last step finishes the ticket', () => {
    assert.deepEqual(nextStep(planned, 'merge', 'merged', 1), {
      to: 'finish',
    })
  })

  test('a routed outcome jumps to its target', () => {
    assert.deepEqual(nextStep(planned, 'approve', 'changes-needed', 1), {
      to: 'step',
      stepId: 'plan',
    })
  })

  test('rejected cancels the ticket unless routed', () => {
    assert.deepEqual(nextStep(planned, 'approve', 'rejected', 1), {
      to: 'cancel',
    })
  })

  test('needs-decision always pauses for a human', () => {
    assert.deepEqual(nextStep(planned, 'build', 'needs-decision', 1), {
      to: 'ask',
      because: 'needs-decision',
    })
  })

  test('an unrouted non-success outcome pauses for a human', () => {
    assert.deepEqual(nextStep(planned, 'build', 'needs-other-repo', 1), {
      to: 'ask',
      because: 'unrouted',
    })
  })

  test('sending back stops at the limit', () => {
    assert.deepEqual(nextStep(planned, 'test', 'changes-needed', 1), {
      to: 'step',
      stepId: 'build',
    })
    assert.deepEqual(nextStep(planned, 'test', 'changes-needed', 2), {
      to: 'ask',
      because: 'limit',
    })
  })

  test('a limit route replaces the pause', () => {
    const workflow = load(`
name: final
description: A final gate that opens the PR with notes when it runs out of rounds.
steps:
  - id: fix
    kind: agent
    role: builder
  - id: final-test
    kind: agent
    role: tester
    limit: 1
    routes:
      changes-needed: fix
      limit: maintain-pr
  - id: maintain-pr
    kind: system
    action: maintain-pr
`)
    assert.deepEqual(nextStep(workflow, 'final-test', 'changes-needed', 1), {
      to: 'step',
      stepId: 'maintain-pr',
    })
  })

  test('review defaults to five finished rounds including the current run', () => {
    const workflow = load(`
name: lead
description: A lead review with no explicit limit.
steps:
  - id: lead
    kind: agent
    role: lead
    routes:
      delegate: run
      done: review
  - id: run
    kind: system
    action: run-tasks
    limit: 20
    routes:
      reported: lead
  - id: review
    kind: agent
    role: reviewer
    routes:
      changes-needed: lead
      limit: maintain-pr
  - id: maintain-pr
    kind: system
    action: maintain-pr
    with:
      ciSettleMinutes: 0
  - id: merge
    kind: system
    action: merge
`)
    for (let runs = 1; runs < 5; runs++)
      assert.deepEqual(nextStep(workflow, 'review', 'changes-needed', runs), {
        to: 'step',
        stepId: 'lead',
      })
    assert.deepEqual(nextStep(workflow, 'review', 'changes-needed', 5), {
      to: 'step',
      stepId: 'maintain-pr',
    })
  })

  test('limits only count routes that send the ticket back', () => {
    const workflow = load(`
name: forward
description: A forward jump is never limited.
steps:
  - id: test
    kind: agent
    role: tester
    limit: 1
    routes:
      changes-needed: escalate
  - id: merge
    kind: system
    action: merge
  - id: escalate
    kind: human
`)
    assert.deepEqual(nextStep(workflow, 'test', 'changes-needed', 5), {
      to: 'step',
      stepId: 'escalate',
    })
  })

  test('an unrouted decision option pauses for a human', () => {
    const workflow = load(`
name: triage
description: Route on a decision.
steps:
  - id: triage
    kind: system
    action: decide
    with:
      question: Bug or feature?
      options:
        bug: Something is broken
        feature: Something new
    routes:
      bug: fix
  - id: fix
    kind: agent
    role: builder
`)
    assert.deepEqual(nextStep(workflow, 'triage', 'bug', 1), {
      to: 'step',
      stepId: 'fix',
    })
    assert.deepEqual(nextStep(workflow, 'triage', 'feature', 1), {
      to: 'ask',
      because: 'unrouted',
    })
  })

  test('rejects outcomes the step cannot report', () => {
    assert.throws(
      () => nextStep(planned, 'plan', 'passed', 1),
      /cannot report "passed"/,
    )
    assert.throws(
      () => nextStep(planned, 'approve', 'needs-decision', 1),
      /cannot report/,
    )
    assert.throws(() => nextStep(planned, 'deploy', 'done', 1), /no step/)
  })
})

describe('describeRoutes', () => {
  test('lists every outcome with its destination, including defaults', () => {
    const testStep = planned.steps[3]
    assert.ok(testStep)
    assert.deepEqual(describeRoutes(planned, testStep), [
      { outcome: 'passed', next: { to: 'step', stepId: 'merge' } },
      { outcome: 'changes-needed', next: { to: 'step', stepId: 'build' } },
      {
        outcome: 'needs-decision',
        next: { to: 'ask', because: 'needs-decision' },
      },
      { outcome: 'limit', next: { to: 'ask', because: 'limit' } },
    ])
  })
})
