import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergePolicy, settledCI } from '../src/domain/auto-merge.ts'
import { evaluateMergeGate, type MergeFacts } from '../src/domain/merge-gate.ts'
const head = 'a'.repeat(40)
const facts: MergeFacts = {
  head,
  localHead: head,
  base: 'b'.repeat(40),
  behind: 0,
  tester: { status: 'finished', outcome: 'passed', commit: head },
  hasTester: true,
  hasReviewer: true,
  reviewer: { status: 'finished', outcome: 'passed', commit: head },
  reproducer: null,
  hasReproducer: false,
  ci: 'passed',
  checks: [],
  feedback: [],
  buildWork: false,
  state: 'OPEN',
  draft: false,
  mergeable: 'MERGEABLE',
  paths: ['ui.ts'],
  migrationGlobs: [],
  trustedKitError: null,
  approvedUnverified: null,
}
const gate = (patch: Partial<MergeFacts> = {}) =>
  evaluateMergeGate({ ...facts, ...patch }, new Date().toISOString())
test('rules merge only ready, tested and reviewed heads with auto-merge on', () => {
  assert.equal(mergePolicy(true, gate()), 'merge')
  assert.equal(mergePolicy(false, gate()), 'owner')
  for (const path of [
    'db/migrations/001.sql',
    '.kipster/kit.yml',
    '.github/workflows/ci.yml',
  ])
    assert.equal(mergePolicy(true, gate({ paths: [path] })), 'owner')
  for (const role of ['tester', 'reviewer'] as const) {
    const missing =
      role === 'tester'
        ? { hasTester: false, tester: null }
        : { hasReviewer: false, reviewer: null }
    assert.equal(gate(missing).ready, true)
    assert.equal(mergePolicy(true, gate(missing)), 'owner')
    assert.equal(
      mergePolicy(
        true,
        gate({
          [role]: {
            status: 'finished',
            outcome: 'passed',
            commit: 'c'.repeat(40),
          },
        }),
      ),
      'wait',
    )
  }
  const flagged = gate({
    reviewer: {
      ...facts.reviewer!,
      ownerReview: { reason: 'Changes public API behavior' },
    },
  })
  assert.equal(flagged.ready, true)
  assert.deepEqual(flagged.needsOwner, [
    'Reviewer requests owner review: Changes public API behavior',
  ])
  assert.equal(mergePolicy(true, flagged), 'owner')
  assert.equal(
    mergePolicy(true, gate({ trustedKitError: 'Invalid rules' })),
    'wait',
  )
  assert.equal(mergePolicy(true, gate({ ci: 'pending' })), 'wait')
})
test('CI settle window expires at its boundary and never suppresses an actual failure', () => {
  const since = '2026-10-05T12:00:00Z',
    now = Date.parse(since)
  assert.equal(
    settledCI({ state: 'none' }, since, 3, now + 179999).state,
    'pending',
  )
  assert.equal(
    settledCI({ state: 'none' }, since, 3, now + 180000).state,
    'none',
  )
  assert.equal(settledCI({ state: 'failed' }, since, 3, now).state, 'failed')
})
