import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { autoMergeFixture } from './helpers/auto-merge.ts'
import { pollAutoMerge } from '../src/engine/auto-merge.ts'
import { pollMergeWait } from '../src/engine/merge-wait.ts'
import {
  pollPullRequestChecks,
  pollPullRequestBase,
} from '../src/engine/pull-requests.ts'
import { listDecisions } from '../src/store/decisions.ts'
import { confirmMergeDecision, baseSyncCount } from '../src/store/auto-merge.ts'
import { setAutoMerge } from '../src/store/repositories.ts'
import {
  completeAttempt,
  resolveAsk,
  listWaitingForMerge,
} from '../src/store/tickets.ts'
import { saveMergeGate, getMergeGate } from '../src/store/merge-gates.ts'
import {
  recordMergedPR,
  pendingPostMergeChecks,
} from '../src/store/post-merge.ts'
import { checkAfterMerge } from '../src/engine/post-merge.ts'
import { runAttempt } from '../src/engine/runner.ts'
import { run } from '../src/executors/process.ts'

for (const band of [
  'acted',
  'confirm-merge',
  'confirm-owner',
  'owner',
  'acted-owner',
  'no-key',
  'error',
  'off',
] as const) {
  test(`merge wait uses ${band} policy, logs factual input and asks once per head`, async (t) => {
    const f = await autoMergeFixture(t)
    if (band.startsWith('confirm')) f.setAnswer(0.8)
    if (band === 'owner') f.setAnswer(0.4)
    if (band === 'acted-owner') f.setAnswer(0.95, 'owner')
    if (band === 'no-key') f.noKey()
    if (band === 'error') f.error()
    if (band === 'off')
      await setAutoMerge(f.store.database, f.repository.id, false)
    const context = await f.context()
    await pollAutoMerge(f.options, context, f.signal)
    const records = await listDecisions(f.store.database, f.ticket.id)
    if (band === 'off') assert.equal(records.length, 0)
    else {
      assert.equal(records.length, 1)
      const decision = records[0]!
      assert.equal(decision.purpose, 'merge')
      assert.equal(decision.facts.headCommit, f.head())
      assert.equal(decision.facts.ticket, undefined)
      assert.equal(
        JSON.stringify(decision.facts).includes('Agent prose sentinel'),
        false,
      )
      assert.deepEqual(decision.facts.files, [
        { path: 'ui.ts', added: 1, removed: 0 },
      ])
      assert.equal(decision.facts.gate?.tester?.commit, f.head())
      assert.equal(decision.facts.ci?.state, 'passed')
      if (band.startsWith('confirm')) {
        assert.equal(decision.pending, true)
        await confirmMergeDecision(
          f.store.database,
          f.ticket.number,
          decision.id,
          band === 'confirm-merge' ? 'merge' : 'owner',
        )
        await pollAutoMerge(f.options, context, f.signal)
      }
    }
    const expected = band === 'acted' || band === 'confirm-merge' ? 1 : 0
    assert.equal(f.merges(), expected)
    await pollAutoMerge(f.options, context, f.signal)
    assert.equal(f.merges(), expected)
    assert.equal(f.requests(), ['no-key', 'off'].includes(band) ? 0 : 1)
    if (expected) {
      await pollMergeWait(f.options, context, f.signal)
      const detail = await f.detail()
      assert.equal(detail.ticket.status, 'done')
      assert.ok(
        detail.events.some(
          (e) =>
            e.kind === 'pull-request.merged' &&
            e.data['mergedBy'] === 'factory' &&
            typeof e.data['decisionId'] === 'number',
        ),
      )
      assert.equal((await pendingPostMergeChecks(f.store.database)).length, 1)
    }
  })
}

test('none stays pending during CI settlement, can fail before registration window ends, and expires to no CI', async (t) => {
  const f = await autoMergeFixture(t, { settle: 3 })
  // The first passed snapshot reached merge; publish again with no checks to exercise a push wait.
  const detail = await f.detail()
  await completeAttempt(f.store.database, detail.ticket.waiting!.attemptId, {
    outcome: 'needs-decision',
    summary: 'Retry publication',
    artifacts: [],
  })
  const ask = (await f.detail()).ticket.waiting!
  await resolveAsk(f.store.database, {
    ticketNumber: f.ticket.number,
    attemptId: ask.attemptId,
    resolution: { action: 'move', stepId: 'publish' },
  })
  f.setChecks({ state: 'none', failures: [] })
  await runAttempt(f.options, await f.next(), f.signal)
  let [context] = await listWaitingForMerge(
    f.store.database,
    'pull-request-checks',
  )
  assert.ok(context)
  assert.equal(
    (await getMergeGate(f.store.database, f.ticket.id))!.latest.facts.ci,
    'pending',
  )
  await pollPullRequestChecks(f.options, context, f.signal)
  assert.equal((await f.detail()).ticket.waiting!.for, 'pull-request-checks')
  f.setChecks({
    state: 'failed',
    failures: [{ name: 'Late CI', url: '', excerpt: 'Late failure' }],
  })
  await pollPullRequestChecks(f.options, context, f.signal)
  assert.equal(
    (await f.detail()).attempts.find((a) => a.id === context!.attempt.id)!
      .outcome,
    'ci-failed',
  )
  const waiting = (await f.detail()).ticket.waiting!
  await resolveAsk(f.store.database, {
    ticketNumber: f.ticket.number,
    attemptId: waiting.attemptId,
    resolution: { action: 'move', stepId: 'publish' },
  })
  f.setChecks({ state: 'none', failures: [] })
  await runAttempt(f.options, await f.next(), f.signal)
  await f.store.database.query(
    "UPDATE attempts SET waiting_since = now() - interval '4 minutes' WHERE ticket_id = $1 AND status = 'waiting'",
    [f.ticket.id],
  )
  ;[context] = await listWaitingForMerge(
    f.store.database,
    'pull-request-checks',
  )
  await pollPullRequestChecks(f.options, context!, f.signal)
  assert.equal((await f.detail()).ticket.currentStep, 'merge')
})

for (const mutation of ['head', 'ci', 'feedback', 'base'] as const) {
  test(`fresh gate prevents a merge when ${mutation} changes after decision; stored green cannot authorize`, async (t) => {
    const f = await autoMergeFixture(t)
    const context = await f.context()
    f.onDecision(async () => {
      if (mutation === 'head') await f.newHead()
      if (mutation === 'ci')
        f.setChecks({
          state: 'failed',
          failures: [{ name: 'CI', url: '', excerpt: 'Changed' }],
        })
      if (mutation === 'feedback')
        f.options.github.feedback = async () => [
          {
            id: 'new',
            url: '',
            author: 'owner',
            body: 'Change this',
            createdAt: new Date().toISOString(),
            changeRequest: true,
          },
        ]
      if (mutation === 'base') {
        await f.commit(f.source, 'base.txt', 'Base moved')
        await run('git', ['push', f.bare, 'main'], { cwd: f.source })
      }
    })
    await pollAutoMerge(f.options, context, f.signal)
    assert.equal(f.requests(), 1)
    assert.equal(f.merges(), 0)
    assert.equal(
      (await getMergeGate(f.store.database, f.ticket.id))!.latest.ready,
      false,
    )
    const snapshot = (await getMergeGate(f.store.database, f.ticket.id))!
    await saveMergeGate(f.store.database, f.ticket.id, {
      ...snapshot.latest,
      ready: true,
      blockers: [],
    })
    await pollAutoMerge(f.options, context, f.signal)
    assert.equal(f.merges(), 0, 'a stored snapshot never grants permission')
  })
}

for (const path of [
  'db/migrations/001.sql',
  '.kipster/roles/builder.md',
  '.github/workflows/check.yml',
]) {
  test(`hard path ${path} never asks the model or merges`, async (t) => {
    const f = await autoMergeFixture(t, { path })
    await pollAutoMerge(f.options, await f.context(), f.signal)
    assert.equal(f.requests(), 0)
    assert.equal(f.merges(), 0)
    assert.ok(
      (await getMergeGate(f.store.database, f.ticket.id))!.latest.needsOwner
        .length,
    )
  })
}
test('untested is ready for owner, while an invalid trusted kit blocks auto-merge', async (t) => {
  const f = await autoMergeFixture(t, { tester: false })
  await pollAutoMerge(f.options, await f.context(), f.signal)
  const gate = (await getMergeGate(f.store.database, f.ticket.id))!.latest
  assert.equal(gate.ready, true)
  assert.deepEqual(gate.needsOwner, ['Untested workflow'])
  assert.equal(f.requests(), 0)
  await f.commit(f.source, '.kipster/kit.yml', 'invalid: true\n')
  await run('git', ['push', f.bare, 'main'], { cwd: f.source })
  await pollAutoMerge(f.options, await f.context(), f.signal)
  assert.ok(
    (await getMergeGate(
      f.store.database,
      f.ticket.id,
    ))!.latest.blockers.includes('Trusted kit is invalid'),
  )
  assert.equal(f.merges(), 0)
})

test('new PR head gets a new decision; old confirmation cannot merge it', async (t) => {
  const f = await autoMergeFixture(t)
  f.setAnswer(0.8)
  const context = await f.context()
  await pollAutoMerge(f.options, context, f.signal)
  const first = (await listDecisions(f.store.database, f.ticket.id))[0]!
  const head = await f.newHead()
  // Record independent proof of the new head without changing the waiting merge attempt.
  await f.store.database.query(
    "UPDATE attempts SET head_commit = $2 WHERE ticket_id = $1 AND step_id = 'test'",
    [f.ticket.id, head],
  )
  await pollAutoMerge(f.options, context, f.signal)
  assert.equal(f.requests(), 2)
  assert.equal((await listDecisions(f.store.database, f.ticket.id)).length, 2)
  await assert.rejects(
    confirmMergeDecision(f.store.database, f.ticket.number, first.id, 'merge'),
    /no longer available/,
  )
  assert.equal(f.merges(), 0)
})

test('post-merge failure opens exactly one bug in a transaction and links it from the original timeline', async (t) => {
  const f = await autoMergeFixture(t)
  const context = await f.context()
  await recordMergedPR(
    f.store.database,
    context,
    {
      url: f.ticket.pullRequestUrl ?? 'https://github.com/fixture/auto/pull/7',
      state: 'MERGED',
      headRefOid: f.head(),
      mergeCommit: { oid: f.head() },
    },
    true,
  )
  const [check] = await pendingPostMergeChecks(f.store.database)
  assert.ok(check)
  f.setPostChecks({
    state: 'failed',
    failures: [
      {
        name: 'Default branch tests',
        url: 'https://checks.test/7',
        excerpt: 'Expected total 3, got 4',
      },
    ],
  })
  await Promise.all([
    checkAfterMerge(f.options, check, f.signal),
    checkAfterMerge(f.options, check, f.signal),
  ])
  await checkAfterMerge(f.options, check, f.signal)
  const { rows } = await f.store.database.query<{
    number: number
    body: string
    workflow_name: string
  }>('SELECT * FROM tickets WHERE id <> $1', [f.ticket.id])
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.workflow_name, 'bug')
  assert.match(rows[0]!.body, /Expected total 3, got 4/)
  assert.ok(rows[0]!.body.includes(f.head()))
  const notes = (await f.detail()).artifacts.filter(
    (a) => a.title === 'Post-merge breakage',
  )
  assert.equal(notes.length, 1)
  assert.match(notes[0]!.content!, new RegExp(`#/tickets/${rows[0]!.number}`))
})

test('no-CI post-merge check uses disposable exact-commit kit harness and retains its logs', async (t) => {
  const f = await autoMergeFixture(t)
  const context = await f.context()
  await recordMergedPR(
    f.store.database,
    context,
    {
      url: 'https://github.com/fixture/auto/pull/7',
      state: 'MERGED',
      headRefOid: f.head(),
      mergeCommit: { oid: f.head() },
    },
    false,
  )
  await f.store.database.query(
    "UPDATE post_merge_checks SET created_at = now() - interval '4 minutes'",
  )
  const [check] = await pendingPostMergeChecks(f.store.database)
  f.setPostChecks({ state: 'none', failures: [] })
  // The merged commit must be present in the repository cache.
  await run('git', ['fetch', 'origin'], {
    cwd: f.options.workspaces.cache(f.repository),
  })
  const original = await run('git', ['status', '--porcelain'], { cwd: f.cwd })
  await checkAfterMerge(f.options, check!, f.signal)
  assert.equal((await pendingPostMergeChecks(f.store.database)).length, 0)
  assert.equal(
    (await f.store.database.query('SELECT status FROM post_merge_checks'))
      .rows[0].status,
    'passed',
  )
  assert.equal(
    await run('git', ['status', '--porcelain'], { cwd: f.cwd }),
    original,
  )
  assert.deepEqual(await readdir(join(f.home, 'verification')), [])
  assert.ok(
    (await f.detail()).artifacts.some(
      (a) => a.title === 'Verification check' && a.observedCommit === f.head(),
    ),
  )
})

test('base re-sync bound parks the owner and an owner retry resets the count', async (t) => {
  const f = await autoMergeFixture(t, { maxBaseSyncs: 1 })
  const context = await f.context()
  await f.commit(f.source, 'base1.txt', 'First base movement')
  await run('git', ['push', f.bare, 'main'], { cwd: f.source })
  assert.equal(await pollPullRequestBase(f.options, context, f.signal), true)
  await runAttempt(f.options, await f.next(), f.signal)
  assert.equal(await baseSyncCount(f.store.database, f.ticket.id), 1)
  // First sync routes to tester. Re-test and publish to resume merge wait.
  const head = await run('git', ['rev-parse', 'HEAD'], { cwd: f.cwd })
  await completeAttempt(
    f.store.database,
    (await f.next()).attempt.id,
    { outcome: 'passed', summary: 'Retested sync', artifacts: [] },
    { headCommit: head },
  )
  await runAttempt(f.options, await f.next(), f.signal)
  await runAttempt(f.options, await f.next(), f.signal)
  await f.commit(f.source, 'base2.txt', 'Second base movement')
  await run('git', ['push', f.bare, 'main'], { cwd: f.source })
  assert.equal(
    await pollPullRequestBase(f.options, await f.context(), f.signal),
    true,
  )
  const parked = await f.detail()
  assert.equal(parked.ticket.waiting!.for, 'ask')
  assert.match(
    parked.ticket.waiting!.summary!,
    /Stopped after 1 consecutive base re-syncs/,
  )
  assert.equal(await run('git', ['rev-parse', 'HEAD'], { cwd: f.cwd }), head)
  await resolveAsk(f.store.database, {
    ticketNumber: f.ticket.number,
    attemptId: parked.ticket.waiting!.attemptId,
    resolution: { action: 'move', stepId: 'publish' },
  })
  assert.equal(await baseSyncCount(f.store.database, f.ticket.id), 0)
})

test('evidence copies precede ticket lock and rollback removes only copies, preserving stable logs', async (t) => {
  const f = await autoMergeFixture(t)
  const directory = join(f.home, 'evidence', String(f.ticket.id))
  const before = await readdir(directory)
  const source = join(f.home, 'evidence.txt')
  await writeFile(source, 'Unique evidence')
  const connection = await f.store.database.connect()
  await connection.query('BEGIN')
  await connection.query(
    'SELECT id FROM tickets WHERE id = $1 FOR NO KEY UPDATE',
    [f.ticket.id],
  )
  const oldAttempt = (await f.detail()).attempts[0]!
  const recording = completeAttempt(f.store.database, oldAttempt.id, {
    outcome: 'passed',
    summary: 'Already closed',
    artifacts: [{ kind: 'evidence', title: 'Will roll back', path: source }],
  })
  const deadline = Date.now() + 3000
  while ((await readdir(directory)).length === before.length) {
    assert.ok(Date.now() < deadline, 'Copy waited for the ticket lock')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  await connection.query('ROLLBACK')
  connection.release()
  await assert.rejects(recording, /no longer open/)
  assert.deepEqual(await readdir(directory), before)
})

test('a slow post-merge check cannot hold a scheduler slot or stop another ticket', async (t) => {
  const { listenForEvents } = await import('../src/store/events.ts')
  const { startScheduler } = await import('../src/engine/scheduler.ts')
  const { createTicket, getTicketDetail } =
    await import('../src/store/tickets.ts')
  const { workflowVersion } = await import('../src/library/library.ts')
  const f = await autoMergeFixture(t)
  f.setPR({ state: 'MERGED', mergeCommit: { oid: f.head() } })
  await pollMergeWait(f.options, await f.context(), f.signal)
  const observed = { started: false }
  f.options.github.commitChecks = async (_repo, _branch, _commit, signal) => {
    observed.started = true
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    )
    signal.throwIfAborted()
    return { state: 'pending', failures: [] }
  }
  const workflow = {
    name: 'slot-test',
    description: 'No PR means an immediate owner ask',
    steps: [
      {
        id: 'merge',
        kind: 'system' as const,
        action: 'merge' as const,
        with: {},
        needs: [],
        routes: {},
      },
    ],
  }
  const source = JSON.stringify(workflow)
  const other = await createTicket(f.store.database, {
    repository: f.repository.slug,
    title: 'Another ticket',
    workflow: { workflow, source, version: workflowVersion(source) },
  })
  const events = listenForEvents(f.store.database)
  await events.ready
  const scheduler = await startScheduler({
    ...f.options,
    config: { ...f.options.config, concurrency: 1 },
    events,
    fallbackMs: 20,
    mergePollMs: 20,
  })
  try {
    const deadline = Date.now() + 5000
    while (
      !observed.started ||
      (await getTicketDetail(f.store.database, other.number))!.ticket.waiting
        ?.for !== 'ask'
    ) {
      assert.ok(Date.now() < deadline, 'Post-merge work blocked another ticket')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal((await pendingPostMergeChecks(f.store.database)).length, 1)
  } finally {
    await scheduler.close()
    await events.close()
  }
})

test('SQL rollback cleans copied evidence while preserving its source and factory-owned live log', async (t) => {
  const { addAttemptArtifacts } = await import('../src/store/tickets.ts')
  const { readFile } = await import('node:fs/promises')
  const f = await autoMergeFixture(t)
  const context = await f.context()
  const directory = join(f.home, 'evidence', String(f.ticket.id))
  const stable = join(directory, 'live.log')
  const source = join(f.home, 'source.txt')
  await writeFile(stable, 'Live log stays')
  await writeFile(source, 'Source stays')
  const before = await readdir(directory)
  await f.store.database.query(
    `CREATE FUNCTION reject_test_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.title = 'Rollback evidence' THEN RAISE EXCEPTION 'fixture rollback'; END IF; RETURN NEW; END $$`,
  )
  await f.store.database.query(
    'CREATE TRIGGER reject_test_evidence BEFORE INSERT ON artifacts FOR EACH ROW EXECUTE FUNCTION reject_test_evidence()',
  )
  await assert.rejects(
    addAttemptArtifacts(f.store.database, context.attempt.id, [
      { kind: 'log', title: 'Live', path: stable },
      { kind: 'evidence', title: 'Rollback evidence', path: source },
    ]),
    /fixture rollback/,
  )
  assert.deepEqual(await readdir(directory), before)
  assert.equal(await readFile(stable, 'utf8'), 'Live log stays')
  assert.equal(await readFile(source, 'utf8'), 'Source stays')
  assert.equal(
    (await f.detail()).artifacts.some((a) => a.title === 'Live'),
    false,
  )
})

test('a saved confident merge cannot override a hard path', async (t) => {
  const { reserveMergeDecision, saveMergeDecision } =
    await import('../src/store/auto-merge.ts')
  const { refreshMergeGate } = await import('../src/engine/merge-gate.ts')
  const { mergeQuestion } = await import('../src/domain/auto-merge.ts')
  const f = await autoMergeFixture(t, { path: 'db/migrations/004.sql' })
  const context = await f.context()
  const { gate } = await refreshMergeGate(f.options, context, f.signal)
  const input = {
    ...mergeQuestion,
    facts: {
      base: { ref: 'origin/main', commit: gate.facts.base },
      headCommit: f.head(),
      files: [{ path: 'db/migrations/004.sql', added: 1, removed: 0 }],
      verdicts: [],
      ci: { commit: f.head(), state: 'passed' },
    },
    answer: {
      model: 'jev-1.13.0',
      choice: 'merge',
      confidence: 0.99,
      probabilities: { merge: 0.99, owner: 0.01 },
      usage: { inputTokens: 10, outputTokens: 10 },
    },
    band: 'acted' as const,
    reason: null,
    durationMs: 10,
  }
  const id = await reserveMergeDecision(
    f.store.database,
    f.ticket.id,
    context.attempt.id,
    input,
  )
  await saveMergeDecision(f.store.database, id!, input)
  await pollAutoMerge(f.options, context, f.signal)
  assert.equal(f.merges(), 0)
  assert.equal(f.requests(), 0)
})

test('owner retry preserves the same-head confirmation without asking a second question', async (t) => {
  const f = await autoMergeFixture(t)
  f.setAnswer(0.8)
  let context = await f.context()
  await pollAutoMerge(f.options, context, f.signal)
  const decision = (await listDecisions(f.store.database, f.ticket.id))[0]!
  await completeAttempt(f.store.database, context.attempt.id, {
    outcome: 'needs-decision',
    summary: 'Pause for inspection',
    artifacts: [],
  })
  const ask = (await f.detail()).ticket.waiting!
  await resolveAsk(f.store.database, {
    ticketNumber: f.ticket.number,
    attemptId: ask.attemptId,
    resolution: { action: 'retry' },
  })
  await runAttempt(f.options, await f.next(), f.signal)
  context = await f.context()
  await pollAutoMerge(f.options, context, f.signal)
  assert.equal(f.requests(), 1)
  assert.equal(
    (await listDecisions(f.store.database, f.ticket.id))[0]!.pending,
    true,
  )
  await confirmMergeDecision(
    f.store.database,
    f.ticket.number,
    decision.id,
    'merge',
  )
  await pollAutoMerge(f.options, context, f.signal)
  assert.equal(f.merges(), 1)
})

test('pending post-merge jobs rotate so later merge commits also get checked', async (t) => {
  const { markPostMergePolled } = await import('../src/store/post-merge.ts')
  const f = await autoMergeFixture(t)
  const context = await f.context()
  for (const char of ['a', 'b', 'c'])
    await recordMergedPR(
      f.store.database,
      context,
      {
        url: 'https://github.com/fixture/auto/pull/7',
        state: 'MERGED',
        mergeCommit: { oid: char.repeat(40) },
      },
      true,
    )
  const first = await pendingPostMergeChecks(f.store.database)
  await markPostMergePolled(f.store.database, first[0]!)
  await markPostMergePolled(f.store.database, first[1]!)
  const next = await pendingPostMergeChecks(f.store.database)
  assert.equal(next[0]!.mergeCommit, first[2]!.mergeCommit)
})
