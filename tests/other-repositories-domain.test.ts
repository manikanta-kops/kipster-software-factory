import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  afterCancel,
  afterLinkedTicket,
  parseStepResult,
  ticketStatus,
  waitForOtherRepository,
  type AttemptState,
} from '../src/domain/lifecycle.ts'
import { parseWorkflow } from '../src/domain/workflow.ts'
import { isAction } from '../src/domain/catalog.ts'

const parsed = parseWorkflow(
  'name: sample\ndescription: x\nsteps:\n  - id: build\n    kind: agent\n    role: builder\n',
)
if (!parsed.ok) throw new Error(parsed.errors.join())
const workflow = parsed.workflow
const running: AttemptState[] = [
  {
    stepId: 'build',
    status: 'running',
    outcome: null,
    waitingFor: null,
    next: null,
  },
]
const waiting: AttemptState[] = [
  { ...running[0]!, status: 'waiting', waitingFor: 'other-repo' },
]
const request = {
  repository: 'acme/library',
  title: 'Expose the needed API',
  body: 'Required for the caller change.',
}

test('other repository result is typed, trimmed and defaults to lead', () => {
  const result = parseStepResult({
    outcome: 'needs-other-repo',
    summary: 'Blocked on the API',
    artifacts: [],
    otherRepository: request,
  })
  assert.equal(result.otherRepository?.workflow, 'lead')
  for (const otherRepository of [
    undefined,
    {},
    { repository: 'invalid' },
    { ...request, repository: '../bad' },
    { ...request, title: '' },
    { ...request, body: ' ' },
    { ...request, workflow: 'Invalid' },
    { ...request, unknown: true },
  ])
    assert.throws(
      () =>
        parseStepResult({
          outcome: 'needs-other-repo',
          summary: 'Needs API',
          otherRepository,
        }),
      /Invalid step result/,
    )
  assert.throws(
    () =>
      parseStepResult({
        outcome: 'done',
        summary: 'done',
        otherRepository: request,
      }),
    /other outcomes must omit/,
  )
})

test('a parked builder is running, merged links open a fresh builder and cancelled links ask the owner', () => {
  assert.equal(waitForOtherRepository(workflow, running), 'running')
  assert.equal(ticketStatus(waiting[0]!), 'running')
  const merged = afterLinkedTicket(waiting, true, 'Merged')
  assert.equal(merged.close.outcome, 'needs-other-repo')
  assert.equal(merged.open?.stepId, 'build')
  assert.equal(merged.open?.status, 'pending')
  assert.equal(merged.status, 'queued')
  const cancelled = afterLinkedTicket(waiting, false, 'Linked ticket cancelled')
  assert.equal(cancelled.open?.waitingFor, 'ask')
  assert.equal(cancelled.open?.summary, 'Linked ticket cancelled')
  assert.equal(cancelled.status, 'needs-you')
  assert.equal(afterCancel(waiting).status, 'cancelled')
  assert.throws(() => afterLinkedTicket(running, true, 'bad'), /not waiting/)
  assert.throws(
    () => waitForOtherRepository(workflow, waiting),
    /Only a running builder/,
  )
})

test('deferred child actions are absent and no longer validate', () => {
  for (const action of ['split', 'wait-children']) {
    assert.equal(isAction(action), false)
    const result = parseWorkflow(
      `name: removed\ndescription: x\nsteps:\n  - id: removed\n    kind: system\n    action: ${action}\n`,
    )
    assert.equal(result.ok, false)
  }
})
