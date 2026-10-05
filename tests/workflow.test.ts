import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseWorkflow } from '../src/domain/workflow.ts'

function errorsFor(source: string): readonly string[] {
  const result = parseWorkflow(source)
  assert.equal(result.ok, false, 'expected the workflow to be rejected')
  return result.ok ? [] : result.errors
}

function assertError(source: string, pattern: RegExp) {
  const errors = errorsFor(source)
  assert.ok(
    errors.some((error) => pattern.test(error)),
    `expected an error matching ${pattern}, got:\n${errors.join('\n')}`,
  )
}

const workflow = (steps: string) =>
  `name: sample\ndescription: A sample workflow.\nsteps:\n${steps}`

describe('parseWorkflow', () => {
  test('accepts the three step kinds with routes and limits', () => {
    const result = parseWorkflow(
      workflow(`
  - id: build
    kind: agent
    role: builder
  - id: test
    kind: agent
    role: tester
    needs: [verify]
    limit: 2
    routes:
      changes-needed: build
      limit: ask
  - id: approve
    kind: human
  - id: merge
    kind: system
    action: merge
`),
    )
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(
      result.workflow.steps.map((step) => [step.id, step.kind]),
      [
        ['build', 'agent'],
        ['test', 'agent'],
        ['approve', 'human'],
        ['merge', 'system'],
      ],
    )
  })

  test('reports YAML syntax errors', () => {
    assertError('name: [unclosed', /not valid YAML/)
  })

  test('rejects unknown fields', () => {
    assertError(
      workflow(`
  - id: build
    kind: agent
    role: builder
    model: something
`),
      /model/,
    )
  })

  test('requires a known role for agent steps', () => {
    assertError(
      workflow(`
  - id: build
    kind: agent
    role: wizard
`),
      /role must be one of/,
    )
  })

  test('requires a known action for system steps', () => {
    assertError(
      workflow(`
  - id: ship
    kind: system
    action: deploy
`),
      /action must be one of/,
    )
  })

  test('keeps kinds separate', () => {
    assertError(
      workflow(`
  - id: build
    kind: agent
    role: builder
    action: merge
`),
      /agent steps take a role, not an action/,
    )
    assertError(
      workflow(`
  - id: approve
    kind: human
    role: planner
`),
      /human steps take no role/,
    )
  })

  test('rejects duplicate and reserved step ids', () => {
    assertError(
      workflow(`
  - id: build
    kind: agent
    role: builder
  - id: build
    kind: agent
    role: builder
`),
      /used twice/,
    )
    assertError(
      workflow(`
  - id: finish
    kind: human
`),
      /reserved for an exit/,
    )
  })

  test('checks route keys against what the step can report', () => {
    assertError(
      workflow(`
  - id: build
    kind: agent
    role: builder
    routes:
      passed: build
`),
      /cannot route "passed"/,
    )
  })

  test('checks route targets', () => {
    assertError(
      workflow(`
  - id: test
    kind: agent
    role: tester
    routes:
      changes-needed: biuld
`),
      /unknown step "biuld"/,
    )
  })

  test('only allows a limit route on a step with a limit', () => {
    assertError(
      workflow(`
  - id: test
    kind: agent
    role: tester
    routes:
      limit: ask
`),
      /needs a limit on the step/,
    )
  })

  test('rejects unknown capabilities', () => {
    assertError(
      workflow(`
  - id: test
    kind: agent
    role: tester
    needs: [telepathy]
`),
      /unknown capability "telepathy"/,
    )
  })

  test('validates action parameters', () => {
    assertError(
      workflow(`
  - id: triage
    kind: system
    action: decide
    with:
      question: Which?
      options:
        only: The only option
`),
      /at least two options/,
    )
  })

  test('makes decision options routable outcomes', () => {
    const result = parseWorkflow(
      workflow(`
  - id: triage
    kind: system
    action: decide
    with:
      question: Is this a bug or a feature?
      options:
        bug: Something is broken
        feature: Something new
    routes:
      bug: fix
      feature: plan
  - id: plan
    kind: agent
    role: planner
  - id: fix
    kind: agent
    role: builder
`),
    )
    assert.equal(result.ok, true)
  })
})
