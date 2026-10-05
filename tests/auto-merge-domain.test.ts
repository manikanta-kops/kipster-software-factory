import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mergePolicy,
  settledCI,
  mergeQuestion,
} from '../src/domain/auto-merge.ts'
import { evaluateMergeGate, type MergeFacts } from '../src/domain/merge-gate.ts'
import type { DecisionRecord } from '../src/domain/decisions.ts'
const head = 'a'.repeat(40)
const facts: MergeFacts = {
  head,
  localHead: head,
  base: 'b'.repeat(40),
  behind: 0,
  tester: { status: 'finished', outcome: 'passed', commit: head },
  hasTester: true,
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
const decision: DecisionRecord = {
  ...mergeQuestion,
  id: 1,
  ticketId: 1,
  ticketNumber: 1,
  attemptId: 1,
  stepId: 'merge',
  workflow: 'feature',
  workflowVersion: 'v1',
  facts: {
    base: { ref: 'origin/main', commit: facts.base },
    headCommit: head,
    files: [],
    verdicts: [],
    ci: null,
  },
  answer: {
    model: 'jev-1.13.0',
    choice: 'merge',
    probabilities: { merge: 0.99, owner: 0.01 },
    confidence: 0.95,
    usage: { inputTokens: 1, outputTokens: 1 },
  },
  band: 'acted',
  reason: null,
  durationMs: 1,
  finalOption: 'merge',
  decidedBy: 'model',
  overridden: false,
  pending: false,
  createdAt: '',
  decidedAt: '',
}
test('policy bands and owner overrides stay behind the hard gate', () => {
  assert.equal(mergePolicy(true, gate()), 'ask')
  assert.equal(mergePolicy(false, gate(), decision), 'owner')
  assert.equal(mergePolicy(true, gate(), decision), 'merge')
  assert.equal(
    mergePolicy(true, gate(), {
      ...decision,
      band: 'confirm',
      finalOption: null,
    }),
    'confirm',
  )
  assert.equal(
    mergePolicy(true, gate(), {
      ...decision,
      band: 'confirm',
      finalOption: 'merge',
      decidedBy: 'owner',
    }),
    'merge',
  )
  for (const band of ['owner', 'no-key', 'error'] as const)
    assert.equal(
      mergePolicy(true, gate(), { ...decision, band, finalOption: null }),
      'owner',
    )
  assert.equal(
    mergePolicy(true, gate(), { ...decision, finalOption: 'owner' }),
    'owner',
  )
  for (const path of [
    'db/migrations/001.sql',
    '.kipster/kit.yml',
    '.github/workflows/ci.yml',
  ])
    assert.equal(mergePolicy(true, gate({ paths: [path] }), decision), 'owner')
  assert.equal(
    mergePolicy(true, gate({ hasTester: false, tester: null }), decision),
    'owner',
  )
  assert.equal(gate({ hasTester: false, tester: null }).ready, true)
  assert.equal(
    mergePolicy(true, gate({ trustedKitError: 'Invalid rules' }), decision),
    'wait',
  )
  assert.equal(mergePolicy(true, gate({ ci: 'pending' }), decision), 'wait')
  assert.equal(
    mergePolicy(true, gate(), {
      ...decision,
      facts: { ...decision.facts, headCommit: 'c'.repeat(40) },
    }),
    'ask',
  )
  assert.equal(
    mergePolicy(true, gate(), { ...decision, mergeRequestedAt: 'now' }),
    'owner',
  )
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
