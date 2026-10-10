import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkCapabilities } from '../src/domain/lifecycle.ts'
import type { Artifact, Attempt } from '../src/domain/records.ts'
import { checkerVerdict, untestedReasons } from '../src/domain/task-testing.ts'
import { builtInWorkflow } from './helpers/store.ts'
import { withUntestedNotice } from '../src/engine/pr-writer.ts'

const repository = { slug: 'acme/app', capabilities: [] }
const head = 'a'.repeat(40)

test('task, task-pr and lead testers run without a verify capability; bug still needs it', async () => {
  for (const name of ['task', 'task-pr', 'lead']) {
    const { workflow } = await builtInWorkflow(name)
    assert.doesNotThrow(() => checkCapabilities(workflow, repository))
    assert.ok(
      workflow.steps.some(
        (step) =>
          step.kind === 'agent' &&
          step.role === 'tester' &&
          step.needs.length === 0,
      ),
    )
  }
  const { workflow } = await builtInWorkflow('bug')
  assert.throws(
    () => checkCapabilities(workflow, repository),
    /needs capabilities/,
  )
})

function attempt(id: number, stepId: string, outcome: string): Attempt {
  return {
    id,
    ticketId: 1,
    stepId,
    status: 'finished',
    outcome,
    summary: null,
    error: null,
    executor: 'codex',
    waitingFor: null,
    askReason: null,
    next: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    claimedAt: null,
    startedAt: null,
    waitingSince: null,
    headCommit: head,
    finishedAt: null,
    inputTokens: null,
    outputTokens: null,
  }
}

function evidence(
  id: number,
  attemptId: number,
  scenarioResult: NonNullable<Artifact['scenarioResult']>,
): Artifact {
  return {
    id,
    ticketId: 1,
    attemptId,
    stepId: 'test',
    kind: 'evidence',
    title: `Evidence ${id}`,
    content: 'Observed',
    path: null,
    mediaType: 'text/markdown',
    createdAt: '2026-01-01T00:00:00.000Z',
    scenario: `Scenario ${id}`,
    scenarioResult,
  }
}

test('untested means the latest checker reported something unverified', async () => {
  const { workflow } = await builtInWorkflow('task')
  const facts = (artifacts: Artifact[]) => ({
    ticket: {},
    workflow,
    attempts: [
      attempt(1, 'build', 'done'),
      attempt(2, 'test', 'passed'),
      attempt(3, 'build', 'done'),
      attempt(4, 'test', 'passed'),
    ],
    artifacts,
  })
  const passed = facts([evidence(1, 4, 'passed')])
  assert.deepEqual(untestedReasons(passed), [])
  assert.equal(checkerVerdict(passed), `Checker test passed at ${head}.`)

  const unverified = facts([
    evidence(1, 2, 'unverified'),
    evidence(2, 4, 'passed'),
    evidence(3, 4, 'unverified'),
  ])
  assert.deepEqual(untestedReasons(unverified), [
    'Unverified by test: Scenario 3',
  ])
  assert.equal(
    checkerVerdict(unverified),
    `Checker test passed at ${head} with unverified items. Unverified by test: Scenario 3.`,
  )

  assert.deepEqual(
    untestedReasons({ ...facts([]), attempts: [attempt(1, 'build', 'done')] }),
    [],
  )
  assert.equal(
    checkerVerdict({ ...facts([]), attempts: [attempt(1, 'build', 'done')] }),
    'No checker ran.',
  )
})

test('stored skipped steps on old tickets still read as untested', async () => {
  const { workflow } = await builtInWorkflow('task')
  const old = {
    ticket: {
      skippedSteps: [{ stepId: 'test', missingCapabilities: ['verify'] }],
    },
    workflow,
    attempts: [attempt(1, 'build', 'done')],
    artifacts: [],
  }
  const reasons = untestedReasons(old)
  assert.deepEqual(reasons, ['Untested: no verify capability (skipped test)'])
  assert.equal(
    checkerVerdict(old),
    'Landed untested. Untested: no verify capability (skipped test).',
  )
  const body = withUntestedNotice('Description', reasons)
  assert.match(body, /Untested: no verify capability/)
  assert.equal(withUntestedNotice(body, reasons), body)
})
