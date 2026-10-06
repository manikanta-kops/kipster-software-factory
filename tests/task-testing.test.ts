import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkCapabilities } from '../src/domain/lifecycle.ts'
import {
  withoutSkippedSteps,
  untestedReasons,
} from '../src/domain/task-testing.ts'
import { nextStep } from '../src/domain/routing.ts'
import { builtInWorkflow } from './helpers/store.ts'
import { withUntestedNotice } from '../src/engine/pr-writer.ts'

const repository = { slug: 'acme/app', capabilities: [] }

test('only child task and task-pr testers may skip missing needs', async () => {
  for (const name of ['task', 'task-pr']) {
    const { workflow } = await builtInWorkflow(name)
    assert.throws(
      () => checkCapabilities(workflow, repository),
      /needs capabilities/,
    )
    assert.deepEqual(checkCapabilities(workflow, repository, true), [
      { stepId: 'test', missingCapabilities: ['verify'] },
    ])
    assert.deepEqual(
      checkCapabilities(
        workflow,
        { ...repository, capabilities: ['verify'] },
        true,
      ),
      [],
    )
    const reproducer = {
      ...workflow,
      steps: workflow.steps.map((step) =>
        step.kind === 'agent' && step.role === 'tester'
          ? { ...step, role: 'reproducer' as const }
          : step,
      ),
    }
    assert.throws(
      () => checkCapabilities(reproducer, repository, true),
      /needs capabilities/,
    )
  }
  for (const name of ['feature', 'bug']) {
    const { workflow } = await builtInWorkflow(name)
    assert.throws(
      () => checkCapabilities(workflow, repository, true),
      /needs capabilities/,
    )
  }
})

test('removing a tester preserves default progression and redirects explicit routes in task-pr', async () => {
  for (const name of ['task', 'task-pr']) {
    const { workflow } = await builtInWorkflow(name)
    const effective = withoutSkippedSteps(
      workflow,
      checkCapabilities(workflow, repository, true),
    )
    assert.deepEqual(
      nextStep(effective, 'build', 'done', 1),
      name === 'task' ? { to: 'finish' } : { to: 'step', stepId: 'review' },
    )
    if (name === 'task-pr')
      assert.deepEqual(nextStep(effective, 'maintain-pr', 'base-moved', 1), {
        to: 'step',
        stepId: 'review',
      })
    assert.equal(
      workflow.steps.some((step) => step.id === 'test'),
      true,
    )
    assert.equal(
      effective.steps.some((step) => step.id === 'test'),
      false,
    )
    assert.equal(withoutSkippedSteps(workflow, []), workflow)
  }
})

test('untested notice is added even when the writer omits it, and is not duplicated', () => {
  const reasons = untestedReasons({
    ticket: {
      skippedSteps: [{ stepId: 'test', missingCapabilities: ['verify'] }],
    },
  })
  const body = withUntestedNotice('Description', reasons)
  assert.match(body, /Untested: no verify capability/)
  assert.equal(withUntestedNotice(body, reasons), body)
})
