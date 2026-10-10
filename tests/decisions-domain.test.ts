import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decisionBand } from '../src/domain/decisions.ts'
import { afterTypedDecision, afterResult } from '../src/domain/lifecycle.ts'
import { decisionWorkflow } from './helpers/decisions.ts'

test('confidence bands include both boundaries and reject invalid confidence/bands', () => {
  for (const [confidence, expected] of [
    [1, 'acted'],
    [0.9, 'acted'],
    [0.899, 'confirm'],
    [0.6, 'confirm'],
    [0.599, 'owner'],
    [0, 'owner'],
  ] as const)
    assert.equal(decisionBand(confidence), expected)
  assert.equal(decisionBand(0.75, { act: 0.8, confirm: 0.7 }), 'confirm')
  for (const invalid of [NaN, Infinity, -0.1, 1.1])
    assert.throws(() => decisionBand(invalid))
  assert.throws(() => decisionBand(0.8, { act: 0.6, confirm: 0.9 }))
})
test('owner choices use the identical option routes and run limits as model outcomes', async () => {
  const { workflow } = await decisionWorkflow()
  for (const choice of ['proceed', 'review']) {
    const model = afterResult(
      workflow,
      [
        {
          stepId: 'classify',
          status: 'running',
          outcome: null,
          waitingFor: null,
          next: null,
        },
      ],
      { outcome: choice, summary: `Owner chose ${choice}` },
    )
    const owner = afterTypedDecision(
      workflow,
      [
        {
          stepId: 'classify',
          status: 'waiting',
          outcome: null,
          waitingFor: 'decision',
          next: null,
        },
      ],
      choice,
    )
    assert.deepEqual(owner, model)
  }
  assert.throws(() =>
    afterTypedDecision(
      workflow,
      [
        {
          stepId: 'classify',
          status: 'waiting',
          outcome: null,
          waitingFor: 'decision',
          next: null,
        },
      ],
      'approved',
    ),
  )
  assert.throws(() =>
    afterTypedDecision(
      workflow,
      [
        {
          stepId: 'classify',
          status: 'waiting',
          outcome: null,
          waitingFor: 'human',
          next: null,
        },
      ],
      'proceed',
    ),
  )
})
