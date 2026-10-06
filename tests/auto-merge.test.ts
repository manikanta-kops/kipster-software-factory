import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { autoMergeFixture } from './helpers/auto-merge.ts'
import { pollAutoMerge } from '../src/engine/auto-merge.ts'
import { pollMergeWait } from '../src/engine/merge-wait.ts'
import {
  pollPullRequestChecks,
  pollPullRequestBase,
} from '../src/engine/pull-requests.ts'
import { listDecisions } from '../src/store/decisions.ts'
import { markMergeRequested, baseSyncCount } from '../src/store/auto-merge.ts'
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
import { withPreparedArtifacts } from '../src/store/artifact-preparation.ts'
import { transaction } from '../src/store/database.ts'

test('ready tested and reviewed head merges without a key or any model call and records factory attribution', async (t) => {
  const f = await autoMergeFixture(t)
  f.noKey()
  const context = await f.context()
  await pollAutoMerge(f.options, context, f.signal)
  assert.equal(f.merges(), 1)
  assert.equal(f.requests(), 0)
  assert.deepEqual(await listDecisions(f.store.database, f.ticket.id), [])
  await pollMergeWait(f.options, context, f.signal)
  const detail = await f.detail()
  assert.equal(detail.ticket.status, 'done')
  assert.ok(
    detail.events.some((e) => e.kind === 'pull-request.merge-requested'),
  )
  assert.ok(
    detail.events.some(
      (e) =>
        e.kind === 'pull-request.merged' && e.data['mergedBy'] === 'factory',
    ),
  )
  assert.equal((await pendingPostMergeChecks(f.store.database)).length, 1)
})
test('auto-merge off retains owner merging', async (t) => {
  const f = await autoMergeFixture(t)
  await setAutoMerge(f.store.database, f.repository.id, false)
  await pollAutoMerge(f.options, await f.context(), f.signal)
  assert.equal(f.merges(), 0)
  assert.equal(f.requests(), 0)
  assert.equal(
    (await f.store.database.query('SELECT * FROM merge_requests')).rows.length,
    0,
  )
})
for (const settings of [
  { reviewer: false },
  { ownerReview: 'Changes permission checks' },
]) {
  test(`reviewer owner policy: ${JSON.stringify(settings)}`, async (t) => {
    const f = await autoMergeFixture(t, settings)
    await pollAutoMerge(f.options, await f.context(), f.signal)
    const gate = (await getMergeGate(f.store.database, f.ticket.id))!.latest
    assert.equal(gate.ready, true)
    assert.deepEqual(gate.needsOwner, [
      settings.reviewer === false
        ? 'Unreviewed workflow'
        : 'Reviewer requests owner review: Changes permission checks',
    ])
    assert.equal(f.merges(), 0)
    assert.equal(f.requests(), 0)
    if (settings.ownerReview)
      assert.deepEqual(
        (await f.detail()).attempts.find((a) => a.stepId === 'review')!
          .ownerReview,
        { reason: settings.ownerReview },
      )
  })
}
for (const role of ['test', 'review']) {
  test(`older ${role} verdict cannot authorize the new PR head`, async (t) => {
    const f = await autoMergeFixture(t)
    const head = await f.newHead()
    await f.store.database.query(
      'UPDATE attempts SET head_commit = $2 WHERE ticket_id = $1 AND step_id <> $3',
      [f.ticket.id, head, role],
    )
    await pollAutoMerge(f.options, await f.context(), f.signal)
    assert.equal(f.merges(), 0)
    assert.equal(
      (await getMergeGate(f.store.database, f.ticket.id))!.latest.ready,
      false,
    )
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
  test(`fresh gate prevents a merge when ${mutation} changes between gate checks; stored green cannot authorize`, async (t) => {
    const f = await autoMergeFixture(t)
    const context = await f.context()
    if (mutation === 'base') {
      const prepare = f.options.workspaces.prepareRepository.bind(
        f.options.workspaces,
      )
      let preparations = 0
      f.options.workspaces.prepareRepository = async (...args) => {
        if (++preparations === 2) {
          await f.commit(f.source, 'base.txt', 'Base moved')
          await run('git', ['push', f.bare, 'main'], { cwd: f.source })
        }
        return prepare(...args)
      }
    }
    let inspections = 0
    f.onInspect(async () => {
      if (++inspections !== 2) return
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
    })
    await pollAutoMerge(f.options, context, f.signal)
    assert.equal(f.requests(), 0)
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
  const f = await autoMergeFixture(t, {
    maxBaseSyncs: 1,
    tester: false,
    reviewer: false,
  })
  const context = await f.context()
  await f.commit(f.source, 'base1.txt', 'First base movement')
  await run('git', ['push', f.bare, 'main'], { cwd: f.source })
  assert.equal(await pollPullRequestBase(f.options, context, f.signal), true)
  await runAttempt(f.options, await f.next(), f.signal)
  assert.equal(await baseSyncCount(f.store.database, f.ticket.id), 1)
  const head = await run('git', ['rev-parse', 'HEAD'], { cwd: f.cwd })
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

test('an error after committing evidence preserves its referenced copy', async (t) => {
  const f = await autoMergeFixture(t)
  const context = await f.context()
  const source = join(f.home, 'committed-evidence.txt')
  await writeFile(source, 'Committed evidence survives a lost acknowledgement')
  await assert.rejects(
    withPreparedArtifacts(
      f.store.database,
      context.attempt.id,
      [{ kind: 'evidence', title: 'Committed evidence', path: source }],
      async ([artifact]) => {
        await transaction(f.store.database, async (connection) => {
          await connection.query(
            `INSERT INTO artifacts(ticket_id, attempt_id, kind, title, path, media_type)
             VALUES ($1, $2, 'evidence', 'Committed evidence', $3, $4)`,
            [
              f.ticket.id,
              context.attempt.id,
              artifact!.path,
              artifact!.mediaType,
            ],
          )
        })
        throw new Error('Commit acknowledgement lost')
      },
    ),
    /Commit acknowledgement lost/,
  )
  const retained = (await f.detail()).artifacts.find(
    (artifact) => artifact.title === 'Committed evidence',
  )!
  assert.notEqual(retained.path, source)
  assert.equal(
    await readFile(retained.path!, 'utf8'),
    await readFile(source, 'utf8'),
  )
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

test('a saved merge request cannot override a hard path', async (t) => {
  const { refreshMergeGate } = await import('../src/engine/merge-gate.ts')
  const f = await autoMergeFixture(t, { path: 'db/migrations/004.sql' })
  const context = await f.context()
  const { gate } = await refreshMergeGate(f.options, context, f.signal)
  await markMergeRequested(f.store.database, context, {
    ...gate,
    ready: true,
    needsOwner: [],
  })
  await pollAutoMerge(f.options, context, f.signal)
  assert.equal(f.merges(), 0)
  assert.equal(f.requests(), 0)
})

test('a transient merge error retries with fresh facts rather than parking the head for owner', async (t) => {
  const f = await autoMergeFixture(t)
  const merge = f.options.github.merge
  let calls = 0
  f.options.github.merge = async (...args) => {
    if (++calls === 1) throw new Error('GitHub timed out before mutation')
    await merge(...args)
  }
  const context = await f.context()
  await pollAutoMerge(f.options, context, f.signal)
  assert.equal(f.merges(), 0)
  assert.match(
    (await f.store.database.query('SELECT error FROM merge_requests')).rows[0]
      .error,
    /timed out/,
  )
  await pollAutoMerge(f.options, context, f.signal)
  assert.equal(f.merges(), 1)
  await pollMergeWait(f.options, context, f.signal)
  assert.equal((await f.detail()).ticket.status, 'done')
})
for (const lost of ['response', 'process'] as const) {
  test(`merged requested head is attributed to factory after lost ${lost}`, async (t) => {
    const f = await autoMergeFixture(t)
    const context = await f.context()
    if (lost === 'response') {
      const merge = f.options.github.merge
      f.options.github.merge = async (...args) => {
        await merge(...args)
        throw new Error('Response lost after GitHub merged')
      }
      await pollAutoMerge(f.options, context, f.signal)
    } else {
      const { refreshMergeGate } = await import('../src/engine/merge-gate.ts')
      const { gate } = await refreshMergeGate(f.options, context, f.signal)
      await markMergeRequested(f.store.database, context, gate)
      f.setPR({ state: 'MERGED', mergeCommit: { oid: f.head() } })
    }
    assert.equal(
      (await f.store.database.query('SELECT succeeded_at FROM merge_requests'))
        .rows[0].succeeded_at,
      null,
    )
    await pollMergeWait(f.options, context, f.signal)
    const request = (
      await f.store.database.query('SELECT * FROM merge_requests')
    ).rows[0]
    assert.ok(request.succeeded_at)
    assert.equal(request.error, null)
    assert.ok(
      (await f.detail()).events.some(
        (e) =>
          e.kind === 'pull-request.merged' && e.data['mergedBy'] === 'factory',
      ),
    )
    assert.match(
      (await f.detail()).attempts.at(-1)!.summary!,
      /Merged by factory/,
    )
  })
}
test('a merge at a different requested head is attributed to owner', async (t) => {
  const f = await autoMergeFixture(t)
  const context = await f.context()
  const { refreshMergeGate } = await import('../src/engine/merge-gate.ts')
  const { gate } = await refreshMergeGate(f.options, context, f.signal)
  await markMergeRequested(f.store.database, context, {
    ...gate,
    facts: { ...gate.facts, head: 'a'.repeat(40) },
  })
  f.setPR({ state: 'MERGED', mergeCommit: { oid: f.head() } })
  await pollMergeWait(f.options, context, f.signal)
  assert.ok(
    (await f.detail()).events.some(
      (e) => e.kind === 'pull-request.merged' && e.data['mergedBy'] === 'owner',
    ),
  )
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

test('kit infrastructure failures are persisted and stop after three attempts', async (t) => {
  const f = await autoMergeFixture(t)
  await recordMergedPR(
    f.store.database,
    await f.context(),
    { ...f.pr(), state: 'MERGED', mergeCommit: { oid: f.head() } },
    false,
  )
  await f.store.database.query(
    "UPDATE post_merge_checks SET created_at = now() - interval '4 minutes'",
  )
  f.setPostChecks({ state: 'none', failures: [] })
  const unavailableHome = join(f.root, 'not-a-directory')
  await writeFile(unavailableHome, 'A file prevents verification scratch setup')
  const options = { ...f.options, home: unavailableHome }
  for (let count = 1; count <= 3; count++) {
    const [check] = await pendingPostMergeChecks(f.store.database)
    assert.ok(check)
    await checkAfterMerge(options, check, f.signal)
    const row = (
      await f.store.database.query('SELECT * FROM post_merge_checks')
    ).rows[0]
    assert.equal(row.kit_failures, count)
    assert.equal(row.status, count === 3 ? 'unavailable' : 'pending')
    assert.match(row.kit_error, /ENOTDIR/)
  }
  assert.deepEqual(await pendingPostMergeChecks(f.store.database), [])
  assert.equal(
    (await f.store.database.query('SELECT count(*)::int AS n FROM tickets'))
      .rows[0].n,
    1,
  )
  const notes = (await f.detail()).artifacts.filter(
    (a) => a.title === 'Post-merge check unavailable',
  )
  assert.equal(notes.length, 1)
  const stored = (
    await f.store.database.query('SELECT checks FROM post_merge_checks')
  ).rows[0].checks
  assert.match(stored.failures[0].excerpt, /after 3 attempts.*ENOTDIR/s)
})

test('tester work breaks a base re-sync streak', async (t) => {
  const f = await autoMergeFixture(t, { maxBaseSyncs: 1 })
  await f.commit(f.source, 'advanced.txt', 'Moved base')
  await run('git', ['push', f.bare, 'main'], { cwd: f.source })
  await pollPullRequestBase(f.options, await f.context(), f.signal)
  await runAttempt(f.options, await f.next(), f.signal)
  assert.equal(await baseSyncCount(f.store.database, f.ticket.id), 1)
  const tester = await f.next()
  assert.equal(tester.step.id, 'test')
  assert.equal(await baseSyncCount(f.store.database, f.ticket.id), 0)
})

test('a base merge before the first publication does not count as a re-sync', async (t) => {
  const f = await autoMergeFixture(t, { initialBaseMove: true })
  assert.equal((await f.detail()).ticket.currentStep, 'test')
  assert.equal(await baseSyncCount(f.store.database, f.ticket.id), 0)
})

test('builder work resets the re-sync streak before a feedback rebuild', async (t) => {
  const { createTicket } = await import('../src/store/tickets.ts')
  const { workflowVersion } = await import('../src/library/library.ts')
  const f = await autoMergeFixture(t)
  const workflow = {
    name: 'build-reset',
    description: 'A feedback rebuild',
    steps: [
      {
        id: 'fix',
        kind: 'agent' as const,
        role: 'builder' as const,
        needs: [],
        routes: {},
      },
    ],
  }
  const source = JSON.stringify(workflow)
  const other = await createTicket(f.store.database, {
    repository: f.repository.slug,
    title: 'Feedback rebuild',
    workflow: { workflow, source, version: workflowVersion(source) },
  })
  await f.store.database.query(
    'INSERT INTO base_syncs(ticket_id, count) VALUES ($1, 3)',
    [other.id],
  )
  await f.next()
  assert.equal(await baseSyncCount(f.store.database, other.id), 0)
})

test('a background merge error with a failed gate invalidation does not reject the job or stop the scheduler', async (t) => {
  const { listenForEvents } = await import('../src/store/events.ts')
  const { startScheduler } = await import('../src/engine/scheduler.ts')
  const f = await autoMergeFixture(t)
  await f.store.database.query(
    "CREATE FUNCTION reject_gate_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'gate invalidation unavailable'; END $$",
  )
  await f.store.database.query(
    'CREATE TRIGGER reject_gate_update BEFORE UPDATE ON merge_gates FOR EACH ROW EXECUTE FUNCTION reject_gate_update()',
  )
  f.options.github.inspect = async () => {
    throw new Error('GitHub observation failed')
  }
  const errors: string[] = []
  const events = listenForEvents(f.store.database)
  await events.ready
  const scheduler = await startScheduler({
    ...f.options,
    events,
    fallbackMs: 20,
    mergePollMs: 20,
    onError: (error) => {
      errors.push(String(error))
    },
  })
  try {
    const deadline = Date.now() + 5000
    while (
      errors.filter((error) => error.includes('gate invalidation unavailable'))
        .length < 2
    ) {
      assert.ok(
        Date.now() < deadline,
        'Scheduler did not continue polling after invalidation failed',
      )
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.ok(
      errors.some((error) => error.includes('GitHub observation failed')),
    )
  } finally {
    await scheduler.close()
    await events.close()
  }
})

test('only a reviewer may return the typed owner-review field', async (t) => {
  const { readResult } = await import('../src/engine/prompt.ts')
  const f = await autoMergeFixture(t)
  await writeFile(
    join(f.home, 'result.json'),
    JSON.stringify({
      outcome: 'passed',
      summary: 'Correct but sensitive',
      artifacts: [],
      ownerReview: { reason: 'Changes permission checks' },
    }),
  )
  assert.deepEqual((await readResult(f.home, 'reviewer', f.home)).ownerReview, {
    reason: 'Changes permission checks',
  })
  await assert.rejects(readResult(f.home, 'tester', f.home), /Only a reviewer/)
})
