import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  evaluateMergeGate,
  matchesPath,
  matchOwnerPaths,
  type MergeFacts,
} from '../src/domain/merge-gate.ts'
const head = 'a'.repeat(40)
const green: MergeFacts = {
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
  paths: [],
  migrationGlobs: [],
  trustedKitError: null,
  approvedUnverified: null,
}
const gate = (patch: Partial<MergeFacts> = {}) =>
  evaluateMergeGate({ ...green, ...patch }, '2026-10-05T12:00:00Z')
test('all facts green, and absent checks, are ready', () => {
  assert.equal(gate().ready, true)
  assert.equal(gate({ ci: 'none' }).ready, true)
  assert.equal(gate({ ci: 'none' }).facts.ci, 'none')
})
for (const [name, facts, reason] of [
  ['missing tester', { tester: null }, 'Tester'],
  [
    'old tester',
    {
      tester: { status: 'finished', outcome: 'passed', commit: 'c'.repeat(40) },
    },
    'Tester',
  ],
  [
    'failed tester',
    { tester: { status: 'finished', outcome: 'changes-needed', commit: head } },
    'Tester',
  ],
  [
    'running tester',
    { tester: { status: 'running', outcome: null, commit: head } },
    'Tester',
  ],
  [
    'unknown tester commit',
    { tester: { status: 'finished', outcome: 'passed', commit: null } },
    'Tester',
  ],
  ['missing reproduction', { hasReproducer: true }, 'Reproduction'],
  [
    'stale reproduction',
    {
      hasReproducer: true,
      reproducer: {
        status: 'finished',
        outcome: 'reproduced',
        commit: 'c'.repeat(40),
      },
    },
    'Reproduction',
  ],
  [
    'failed reproduction',
    {
      hasReproducer: true,
      reproducer: {
        status: 'finished',
        outcome: 'not-reproduced',
        commit: head,
      },
    },
    'Reproduction',
  ],
  ['behind base', { behind: 2 }, 'Behind base'],
  ['pending CI', { ci: 'pending' }, 'CI pending'],
  ['failed CI', { ci: 'failed' }, 'CI failed'],
  ['different CI head', { ci: 'head-changed' }, 'CI head-changed'],
  ['feedback', { feedback: ['comment:1'] }, 'Open owner feedback'],
  ['build work', { buildWork: true }, 'Build work'],
  ['closed PR', { state: 'CLOSED' }, 'PR is closed'],
  ['merged PR', { state: 'MERGED' }, 'PR is merged'],
  ['draft', { draft: true }, 'draft'],
  ['unknown draft', { draft: null }, 'draft state is unknown'],
  ['conflict', { mergeable: 'CONFLICTING' }, 'conflicts'],
  ['unknown mergeability', { mergeable: 'UNKNOWN' }, 'unknown'],
  ['local head changed', { localHead: 'c'.repeat(40) }, 'differs'],
  ['invalid trusted kit', { trustedKitError: 'bad YAML' }, 'Trusted kit'],
] satisfies [string, Partial<MergeFacts>, string][]) {
  test(`blocks ${name}`, () => {
    const result = gate(facts)
    assert.equal(result.ready, false)
    assert.ok(result.blockers.some((s) => s.includes(reason)))
  })
}
test('untested always needs owner; proof, checks and unverified approval stay distinct', () => {
  assert.deepEqual(gate({ hasTester: false, tester: null }).needsOwner, [
    'Untested workflow',
  ])
  assert.equal(
    gate({ approvedUnverified: ['Restart persistence'] }).ready,
    true,
  )
  assert.deepEqual(
    gate({ approvedUnverified: ['Restart persistence'] }).needsOwner,
    ['Owner-approved unverified scenarios'],
  )
  assert.equal(
    gate({
      hasReproducer: true,
      reproducer: { status: 'finished', outcome: 'reproduced', commit: head },
    }).ready,
    true,
  )
})
for (const [path, rule] of [
  ['.kipster/kit.yml', 'kit'],
  ['.kipster/roles/tester.md', 'kit'],
  ['.github/workflows/ci.yml', 'ci'],
  ['.github/actions/check/action.yml', 'ci'],
  ['.circleci/config.yml', 'ci'],
  ['.gitlab-ci.yml', 'ci'],
  ['.buildkite/pipeline.yml', 'ci'],
  ['Jenkinsfile', 'ci'],
  ['azure-pipelines.yml', 'ci'],
  ['bitbucket-pipelines.yml', 'ci'],
  ['migrations/001.sql', 'migration'],
  ['src/store/migrations/006.sql', 'migration'],
  ['db/migrate/001.rb', 'migration'],
  ['prisma/migrations/001/migration.sql', 'migration'],
  ['alembic/versions/001.py', 'migration'],
  ['supabase/migrations/001.sql', 'migration'],
] as const)
  test(`hard path rule: ${path}`, () => {
    assert.deepEqual(matchOwnerPaths([path]), [{ path, rule }])
    const result = gate({ paths: [path] })
    assert.equal(result.ready, true)
    assert.match(result.needsOwner[0]!, /Touches/)
  })
test('additive custom migration globs cannot weaken defaults and show exact files', () => {
  assert.deepEqual(
    matchOwnerPaths(
      ['changes/001.sql', 'src/x.ts', '.kipster/kit.yml', 'changes/001.sql'],
      ['changes/*.sql'],
    ),
    [
      { path: '.kipster/kit.yml', rule: 'kit' },
      { path: 'changes/001.sql', rule: 'migration' },
    ],
  )
  assert.equal(matchesPath('migrations/a.sql', '**/migrations/**'), true)
  assert.equal(matchesPath('x/migrations/a.sql', '**/migrations/**'), true)
  assert.equal(matchesPath('changes/nested/001.sql', 'changes/*.sql'), false)
  assert.equal(matchesPath('changes/a.sql', 'changes/?.sql'), true)
  assert.deepEqual(
    matchOwnerPaths([
      'README.md',
      '.github/ISSUE_TEMPLATE/bug.yml',
      'src/migration-helper.ts',
    ]),
    [],
  )
})

test('fact-fetch failures and a different base block cached readiness', () => {
  assert.match(
    gate({ observationError: 'GitHub unavailable' }).blockers.join(),
    /unavailable/,
  )
  assert.match(
    gate({ baseBranchMatches: false }).blockers.join(),
    /different base/,
  )
})
