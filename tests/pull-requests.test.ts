import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Workflow } from '../src/domain/workflow.ts'
import { workflowVersion } from '../src/library/library.ts'
import { engineConfig } from '../src/config.ts'
import { run } from '../src/executors/process.ts'
import type { AgentExecutor } from '../src/executors/cli.ts'
import type { GitHub } from '../src/github/github.ts'
import type { Checks } from '../src/github/checks.ts'
import type { PullRequestFeedback } from '../src/github/feedback.ts'
import {
  createRepository,
  markRepositoryReady,
} from '../src/store/repositories.ts'
import {
  claimAttempts,
  completeAttempt,
  createTicket,
  getTicketDetail,
  listWaitingForMerge,
  markRunning,
  resolveAsk,
} from '../src/store/tickets.ts'
import { isLatestTesterVerdictCurrent } from '../src/store/verdicts.ts'
import { getMergeGate as getSavedMergeGate } from '../src/store/merge-gates.ts'
import { baseSyncCount, beginBaseSync } from '../src/store/auto-merge.ts'
import { createTestStore } from './helpers/store.ts'
import { Workspaces } from '../src/workspace/workspaces.ts'
import { runAttempt, type RunnerOptions } from '../src/engine/runner.ts'
import {
  pollPullRequestChecks,
  pollPullRequestBase,
  pollPullRequestFeedback,
} from '../src/engine/pull-requests.ts'
import { startScheduler } from '../src/engine/scheduler.ts'
import { listenForEvents } from '../src/store/events.ts'
import { FACTORY_MARKER } from '../src/github/feedback.ts'
import { factoryDescription, fitGitHubLimit } from '../src/engine/pr-writer.ts'
import {
  getPullRequestDescription,
  savePullRequestDescription,
} from '../src/store/pull-requests.ts'

const signal = new AbortController().signal
function entry(workflow: Workflow) {
  const source = JSON.stringify(workflow)
  return { workflow, source, version: workflowVersion(source) }
}
async function fixture(
  t: TestContext,
  tester = false,
  timeout = 60,
  reviewer = false,
) {
  const root = await mkdtemp(join(tmpdir(), 'factory-pr-'))
  const home = join(root, 'home')
  const source = join(root, 'source')
  const bare = join(root, 'origin.git')
  await mkdir(home)
  await run('git', ['init', '-b', 'main', source])
  const commit = async (cwd: string, path: string, text: string) => {
    await writeFile(join(cwd, path), text)
    await run('git', ['add', '.'], { cwd })
    await run(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '-m',
        text,
      ],
      { cwd },
    )
    return run('git', ['rev-parse', 'HEAD'], { cwd })
  }
  await commit(source, 'README.md', 'initial')
  await run('git', ['clone', '--bare', source, bare])
  const store = await createTestStore()
  const events = listenForEvents(store.database)
  await events.ready
  const repository = await createRepository(store.database, {
    slug: 'fixture/repo',
    cloneUrl: bare,
  })
  await markRepositoryReady(store.database, repository.id)
  const ticket = await createTicket(store.database, {
    repository: repository.slug,
    title: 'Keep ready',
    workflow: entry({
      name: 'pr-test',
      description: 'System publication',
      steps: [
        ...(tester
          ? [
              {
                id: 'test',
                kind: 'agent' as const,
                role: 'tester' as const,
                needs: [],
                routes: {},
              },
            ]
          : []),
        ...(reviewer
          ? [
              {
                id: 'review',
                kind: 'agent' as const,
                role: 'reviewer' as const,
                needs: [],
                routes: {},
              },
            ]
          : []),
        {
          id: 'publish',
          kind: 'system',
          action: 'maintain-pr',
          needs: [],
          with: {
            ciTimeoutMinutes: timeout,
            ciSettleMinutes: 0,
          },
          routes: reviewer ? { 'base-moved': tester ? 'test' : 'review' } : {},
        },
        {
          id: 'merge',
          kind: 'system',
          action: 'merge',
          needs: [],
          with: {},
          routes: {},
        },
      ],
    }),
  })
  const workspaces = new Workspaces(home)
  const cwd = await workspaces.prepare(ticket, repository, signal)
  const head = await commit(cwd, 'change.txt', 'ticket change')
  const script = join(root, 'script.json')
  await writeFile(script, '{}')
  let writers = 0
  const execute: AgentExecutor = async (invocation) => {
    writers++
    await run(
      process.execPath,
      [
        fileURLToPath(new URL('./fixtures/fake-agent.ts', import.meta.url)),
        invocation.directory,
        script,
        root,
      ],
      { cwd: invocation.cwd, log: invocation.log, signal: invocation.signal },
    )
  }
  let checks: Checks = { state: 'pending', failures: [] }
  let feedback: PullRequestFeedback[] = []
  const bodies: string[] = []
  const checkedHeads: string[] = []
  const github: GitHub = {
    merge: async () => {
      throw new Error('Unexpected merge')
    },
    commitChecks: async () => ({ state: 'none', failures: [] }),
    async maintain(input) {
      bodies.push(input.body)
      return { url: 'https://github.com/fixture/repo/pull/1', state: 'OPEN' }
    },
    async inspect() {
      return {
        url: 'https://github.com/fixture/repo/pull/1',
        state: 'OPEN',
        isDraft: false,
        baseRefName: 'main',
        mergeable: 'MERGEABLE',
        headRefOid: await run('git', ['rev-parse', ticket.branch], {
          cwd: bare,
        }),
      }
    },
    async checks(_repo, _url, checkedHead) {
      checkedHeads.push(checkedHead)
      return checks
    },
    async feedback() {
      return feedback
    },
  }
  const options: RunnerOptions = {
    database: store.database,
    home,
    config: engineConfig.parse({}),
    workspaces,
    github,
    execute,
  }
  const next = async () => {
    const [context] = await claimAttempts(store.database, 1)
    assert.ok(context)
    await markRunning(store.database, context.attempt.id, 'system')
    return context
  }
  const detail = async () =>
    (await getTicketDetail(store.database, ticket.number))!
  if (tester) {
    const context = await next()
    await completeAttempt(
      store.database,
      context.attempt.id,
      { outcome: 'passed', summary: 'Exact commit verified', artifacts: [] },
      { headCommit: head },
    )
  }
  if (reviewer) {
    const context = await next()
    await completeAttempt(
      store.database,
      context.attempt.id,
      { outcome: 'passed', summary: 'Exact commit reviewed', artifacts: [] },
      { headCommit: head },
    )
  }
  let scheduler: Awaited<ReturnType<typeof startScheduler>> | undefined
  t.after(async () => {
    await scheduler?.close()
    await events.close()
    await store.close()
    await rm(root, { recursive: true, force: true })
  })
  const start = async () =>
    (scheduler = await startScheduler({
      ...options,
      events,
      config: engineConfig.parse({ concurrency: 1 }),
      fallbackMs: 25,
      mergePollMs: 25,
    }))
  return {
    root,
    cwd,
    source,
    bare,
    options,
    store,
    ticket,
    head,
    next,
    detail,
    commit,
    bodies,
    checkedHeads,
    writers: () => writers,
    start,
    setChecks: (value: Checks) => {
      checks = value
    },
    setFeedback: (value: PullRequestFeedback[]) => {
      feedback = value
    },
    async publish() {
      const context = await next()
      await runAttempt(options, context, signal)
      return context
    },
    async poll() {
      const [context] = await listWaitingForMerge(
        store.database,
        'pull-request-checks',
      )
      assert.ok(context)
      await pollPullRequestChecks(options, context, signal)
    },
    async advanceBase(path = 'base.txt') {
      const baseHead = await commit(source, path, 'base change')
      await run('git', ['push', bare, 'main'], { cwd: source })
      return baseHead
    },
  }
}

function writerRuns(
  f: Awaited<ReturnType<typeof fixture>>,
  runs: {
    notes?: string[]
    outcome?: string
    missing?: boolean
    crash?: boolean
    invalid?: boolean
  }[],
) {
  const execute = f.options.execute
  let index = 0
  f.options.execute = async (invocation) => {
    await execute(invocation)
    const scripted = runs[index++]!
    if (scripted.crash) throw new Error('Writer session crashed')
    const path = join(invocation.directory, 'result.json')
    if (scripted.missing) await rm(path)
    else
      await writeFile(
        path,
        scripted.invalid
          ? '{invalid'
          : JSON.stringify({
              outcome: scripted.outcome ?? 'done',
              summary: 'Writer run completed',
              artifacts: (scripted.notes ?? []).map((content) => ({
                kind: 'note',
                title: 'PR description',
                content,
              })),
            }),
      )
  }
}

test('maintain-pr merges base without rewriting branch, invokes writer and links concise evidence', async (t) => {
  const f = await fixture(t)
  const base = await f.advanceBase()
  await f.publish()
  const head = await run('git', ['rev-parse', 'HEAD'], { cwd: f.cwd })
  assert.notEqual(head, f.head)
  assert.equal(
    await run('git', ['rev-parse', 'HEAD^1'], { cwd: f.cwd }),
    f.head,
  )
  assert.equal(await run('git', ['rev-parse', 'HEAD^2'], { cwd: f.cwd }), base)
  assert.equal(
    await run('git', ['rev-parse', f.ticket.branch], { cwd: f.bare }),
    head,
  )
  assert.equal(f.writers(), 1)
  assert.match(f.bodies[0]!, new RegExp(`Verified at ${head}`))
  assert.ok(
    f.bodies[0]!.includes(
      `Evidence on ticket #${f.ticket.number} in the factory`,
    ),
  )
  assert.ok(f.bodies[0]!.length < 4100)
  f.setChecks({ state: 'none', failures: [] })
  await f.poll()
  assert.equal((await f.detail()).attempts[0]!.outcome, 'ready')
  assert.deepEqual(f.checkedHeads, [head, head])
})

test('base conflict is aborted and conflicting paths reach builder as findings', async (t) => {
  const f = await fixture(t)
  const before = await f.commit(f.cwd, 'README.md', 'ticket version')
  await f.advanceBase('README.md')
  await f.publish()
  const d = await f.detail()
  assert.equal(d.attempts[0]!.outcome, 'conflict')
  assert.match(
    d.artifacts.find((a) => a.kind === 'finding')!.content!,
    /README.md/,
  )
  assert.equal(await run('git', ['status', '--porcelain'], { cwd: f.cwd }), '')
  assert.equal(await run('git', ['rev-parse', 'HEAD'], { cwd: f.cwd }), before)
  await assert.rejects(
    run('git', ['rev-parse', '--verify', 'MERGE_HEAD'], { cwd: f.cwd }),
  )
  assert.equal(f.bodies.length, 0)
})

for (const state of ['pending', 'passed'] as const) {
  test(`base advances during ${state} CI: queue maintenance without reusing the old verdict`, async (t) => {
    const f = await fixture(t, true)
    await f.publish()
    const base = await f.advanceBase()
    f.setChecks({ state, failures: [] })
    await f.poll()
    const queued = await f.detail()
    assert.equal(queued.ticket.status, 'queued')
    assert.equal(queued.attempts.at(-1)!.stepId, 'publish')
    assert.match(queued.attempts.at(-2)!.summary!, new RegExp(base))
    assert.equal(f.writers(), 1)
    assert.equal(
      await run('git', ['rev-parse', 'HEAD'], { cwd: f.cwd }),
      f.head,
    )
    await f.publish()
    const synced = await f.detail()
    const maintained = synced.attempts.at(-2)!
    assert.equal(maintained.outcome, 'base-moved')
    assert.notEqual(maintained.headCommit, f.head)
    assert.equal(
      await run('git', ['rev-parse', 'HEAD^2'], { cwd: f.cwd }),
      base,
    )
    assert.equal(
      await isLatestTesterVerdictCurrent(
        f.store.database,
        f.ticket.id,
        maintained.headCommit!,
      ),
      false,
    )
    assert.equal(f.writers(), 1, 'stale proof prevents a new writer or push')
  })
}

test('base advances during owner merge wait: queue the previous maintenance step exactly once', async (t) => {
  const f = await fixture(t)
  f.setChecks({ state: 'none', failures: [] })
  await f.publish()
  await runAttempt(f.options, await f.next(), signal)
  const [waiting] = await listWaitingForMerge(f.store.database)
  const base = await f.advanceBase()
  assert.equal(await pollPullRequestBase(f.options, waiting!, signal), true)
  assert.equal(f.writers(), 1)
  assert.equal(await run('git', ['rev-parse', 'HEAD'], { cwd: f.cwd }), f.head)
  await assert.rejects(
    pollPullRequestBase(f.options, waiting!, signal),
    /no longer open/,
  )
  assert.equal(
    (await f.detail()).attempts.filter((a) => a.status === 'pending').length,
    1,
  )
  await f.publish()
  assert.equal(await run('git', ['rev-parse', 'HEAD^2'], { cwd: f.cwd }), base)
  assert.equal(f.writers(), 2)
  assert.equal((await f.detail()).attempts.at(-2)!.outcome, 'ready')
})

for (const alreadyPublished of [false, true]) {
  test(`a reviewed workflow without a tester refreshes stale review after base sync, already published: ${alreadyPublished}`, async (t) => {
    const f = await fixture(t, false, 60, true)
    f.setChecks({ state: 'none', failures: [] })
    await f.publish()
    await runAttempt(f.options, await f.next(), signal)
    const [waiting] = await listWaitingForMerge(f.store.database)
    await f.advanceBase()
    if (alreadyPublished) {
      await f.options.workspaces.prepareRepository(waiting!.repository, signal)
      await run(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.test',
          'merge',
          '--no-edit',
          'origin/main',
        ],
        { cwd: f.cwd },
      )
      await run('git', ['push', 'origin', f.ticket.branch], { cwd: f.cwd })
      for (let sync = 0; sync < 3; sync++)
        assert.equal(
          await beginBaseSync(f.store.database, f.ticket.id, 3),
          true,
        )
    }
    await pollPullRequestBase(f.options, waiting!, signal)
    await f.publish()
    const synced = await f.detail()
    const maintained = synced.attempts.at(-2)!
    assert.equal(maintained.outcome, 'base-moved')
    assert.equal(synced.ticket.currentStep, 'review')
    assert.equal(f.writers(), 1, 'stale review must prevent publication')
    const head = await run('git', ['rev-parse', 'HEAD'], { cwd: f.cwd })
    assert.notEqual(head, f.head)
    const review = await f.next()
    await completeAttempt(
      f.store.database,
      review.attempt.id,
      { outcome: 'passed', summary: 'Synced commit reviewed', artifacts: [] },
      { headCommit: head },
    )
    await f.publish()
    const refreshed = await f.detail()
    assert.equal(f.writers(), 2)
    assert.equal(refreshed.ticket.currentStep, 'merge')
    const gate = await getSavedMergeGate(f.store.database, f.ticket.id)
    assert.equal(gate?.latest.ready, true)
    assert.deepEqual(gate?.latest.needsOwner, ['Untested workflow'])
    if (alreadyPublished) {
      assert.equal(await baseSyncCount(f.store.database, f.ticket.id), 3)
      await runAttempt(f.options, await f.next(), signal)
      const [ownerWait] = await listWaitingForMerge(f.store.database)
      await f.advanceBase('fourth-base-move.txt')
      assert.equal(
        await pollPullRequestBase(f.options, ownerWait!, signal),
        true,
      )
      const bounded = await f.detail()
      assert.equal(bounded.ticket.waiting?.for, 'ask')
      assert.match(
        bounded.attempts.at(-2)!.summary!,
        /3 consecutive base re-syncs/,
      )
      assert.equal(
        await run('git', ['rev-parse', 'HEAD'], { cwd: f.cwd }),
        head,
      )
      assert.equal(f.writers(), 2)
    }
  })
}

test('base movement invalidates a tester verdict; retry cannot reuse it after merge was saved', async (t) => {
  const f = await fixture(t, true)
  assert.deepEqual(
    await isLatestTesterVerdictCurrent(f.store.database, f.ticket.id, f.head),
    true,
  )
  await f.advanceBase()
  await f.publish()
  let d = await f.detail()
  assert.equal(d.attempts[1]!.outcome, 'base-moved')
  assert.equal(f.bodies.length, 0)
  await resolveAsk(f.store.database, {
    ticketNumber: f.ticket.number,
    attemptId: d.ticket.waiting!.attemptId,
    resolution: { action: 'retry' },
  })
  await f.publish()
  d = await f.detail()
  assert.equal(d.attempts.at(-2)!.outcome, 'base-moved')
  const head = await run('git', ['rev-parse', 'HEAD'], { cwd: f.cwd })
  await resolveAsk(f.store.database, {
    ticketNumber: f.ticket.number,
    attemptId: d.ticket.waiting!.attemptId,
    resolution: { action: 'move', stepId: 'test' },
  })
  const retest = await f.next()
  await completeAttempt(
    f.store.database,
    retest.attempt.id,
    { outcome: 'passed', summary: 'Retested', artifacts: [] },
    { headCommit: head },
  )
  await f.publish()
  f.setChecks({ state: 'none', failures: [] })
  await f.poll()
  assert.equal((await f.detail()).ticket.currentStep, 'merge')
})

for (const end of ['passed', 'failed', 'none', 'timeout'] as const) {
  test(`CI pending → ${end}, persisted exact commit and bounded findings`, async (t) => {
    const f = await fixture(t, false, end === 'timeout' ? 0.001 : 60)
    f.setChecks({ state: 'pending', failures: [] })
    await f.publish()
    if (end !== 'timeout') {
      await f.poll()
      assert.equal(
        (await f.detail()).ticket.waiting?.for,
        'pull-request-checks',
      )
      f.setChecks({
        state: end,
        failures:
          end === 'failed'
            ? [
                {
                  name: 'typecheck',
                  url: 'https://github.com/check',
                  excerpt: 'Type mismatch in src/example.ts',
                },
              ]
            : [],
      })
    } else await new Promise((resolve) => setTimeout(resolve, 80))
    await f.poll()
    const d = await f.detail()
    assert.equal(d.attempts[0]!.headCommit, f.head)
    assert.equal(
      d.attempts[0]!.outcome,
      end === 'failed'
        ? 'ci-failed'
        : end === 'timeout'
          ? 'needs-decision'
          : 'ready',
    )
    if (end === 'failed')
      assert.match(
        d.artifacts.find((a) => a.kind === 'finding')!.content!,
        /typecheck.*\n\nType mismatch/s,
      )
    if (end === 'timeout') assert.equal(d.ticket.waiting?.for, 'ask')
  })
}

test('CI wait survives scheduler restart and releases its only execution slot', async (t) => {
  const f = await fixture(t)
  f.setChecks({ state: 'pending', failures: [] })
  await f.publish()
  const first = await f.start()
  await first.close()
  const d = await f.detail()
  await createTicket(f.store.database, {
    repository: 'fixture/repo',
    title: 'Another ticket',
    workflow: entry({
      name: 'other',
      description: 'Proves slot availability',
      steps: [
        {
          kind: 'system',
          id: 'merge',
          action: 'merge',
          with: {},
          needs: [],
          routes: {},
        },
      ],
    }),
  })
  const second = await f.start()
  const end = Date.now() + 5000
  let other = (await getTicketDetail(f.store.database, f.ticket.number + 1))!
  while (other.ticket.waiting?.for !== 'ask') {
    assert.ok(Date.now() < end, 'Waiting CI held the only scheduler slot')
    await new Promise((resolve) => setTimeout(resolve, 25))
    other = (await getTicketDetail(f.store.database, f.ticket.number + 1))!
  }
  const waitingOnCi = (await f.detail()).ticket
  assert.equal(waitingOnCi.waiting?.for, 'pull-request-checks')
  // CI is the factory's wait, so the ticket stays out of Needs you.
  assert.equal(waitingOnCi.status, 'running')
  assert.match(other.attempts[0]!.error!, /without a pull request/)
  f.setChecks({ state: 'passed', failures: [] })
  while ((await f.detail()).ticket.waiting?.for !== 'pull-request-merge') {
    assert.ok(Date.now() < end, 'CI did not resume')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal((await f.detail()).attempts[0]!.id, d.attempts[0]!.id)
  assert.equal(f.writers(), 1)
  await second.close()
})

test('new owner feedback is preserved once across subsequent merge waits; writer refreshes only on new heads', async (t) => {
  const f = await fixture(t)
  await f.publish()
  f.setChecks({ state: 'none', failures: [] })
  await f.poll()
  await runAttempt(f.options, await f.next(), signal)
  const [waiting] = await listWaitingForMerge(f.store.database)
  f.setFeedback([
    {
      id: 'comment:10',
      url: 'https://github.com/comment/10',
      author: 'owner',
      body: 'Please handle empty input.',
      createdAt: new Date().toISOString(),
    },
  ])
  assert.equal(await pollPullRequestFeedback(f.options, waiting!, signal), true)
  let d = await f.detail()
  assert.equal(d.attempts.at(-2)!.outcome, 'changes-needed')
  assert.match(
    d.artifacts.find((a) => a.kind === 'comment')!.content!,
    /Please handle empty input/,
  )
  await resolveAsk(f.store.database, {
    ticketNumber: f.ticket.number,
    attemptId: d.ticket.waiting!.attemptId,
    resolution: { action: 'move', stepId: 'publish' },
  })
  f.setChecks({ state: 'pending', failures: [] })
  await f.publish()
  assert.equal(f.writers(), 1)
  f.setChecks({ state: 'none', failures: [] })
  await f.poll()
  await runAttempt(f.options, await f.next(), signal)
  const [again] = await listWaitingForMerge(f.store.database)
  assert.equal(await pollPullRequestFeedback(f.options, again!, signal), false)
  f.setFeedback([
    {
      id: 'review:11',
      url: 'https://github.com/review/11',
      author: 'reviewer',
      body: 'Needs a correction.',
      createdAt: new Date().toISOString(),
    },
  ])
  await pollPullRequestFeedback(f.options, again!, signal)
  d = await f.detail()
  await resolveAsk(f.store.database, {
    ticketNumber: f.ticket.number,
    attemptId: d.ticket.waiting!.attemptId,
    resolution: { action: 'move', stepId: 'publish' },
  })
  await f.commit(f.cwd, 'fix.txt', 'owner correction')
  await f.publish()
  assert.equal(f.writers(), 2)
  assert.notEqual(f.bodies[0], f.bodies[2])
})

test('writer worktree mutation prevents pushing', async (t) => {
  const f = await fixture(t)
  await writeFile(
    join(f.root, 'script.json'),
    JSON.stringify({ writer: [{ commit: true }] }),
  )
  await assert.rejects(f.publish(), /writer changed the worktree/)
  assert.equal(f.bodies.length, 0)
  assert.equal(
    await readFile(join(f.cwd, 'change-0.txt'), 'utf8'),
    'implemented change 0\n',
  )
})

test('zero settle window permits no checks on the first snapshot', async (t) => {
  const f = await fixture(t)
  f.setChecks({ state: 'none', failures: [] })
  await f.publish()
  const d = await f.detail()
  assert.equal(d.attempts[0]!.outcome, 'ready')
  assert.equal(d.ticket.currentStep, 'merge')
  assert.equal(
    (await listWaitingForMerge(f.store.database, 'pull-request-checks')).length,
    0,
  )
})

test('changed head while waiting cannot use the original commit’s green checks', async (t) => {
  const f = await fixture(t)
  await f.publish()
  await f.commit(f.cwd, 'late.txt', 'late change')
  f.setChecks({ state: 'passed', failures: [] })
  await f.poll()
  const d = await f.detail()
  assert.equal(d.attempts[0]!.outcome, 'needs-decision')
  assert.match(d.ticket.waiting!.summary!, /branch changed/)
  assert.equal(f.checkedHeads.length, 2)
  assert.ok(
    f.checkedHeads.every((head) => head === f.head),
    'CI snapshot stays pinned to the published head',
  )
})

test('writer invalid result retries in a fresh session before publication', async (t) => {
  const f = await fixture(t)
  writerRuns(f, [{ invalid: true }, { notes: ['Second run note'] }])
  const context = await f.publish()
  assert.equal(f.writers(), 2)
  assert.deepEqual(f.bodies, [`Second run note\n\n${FACTORY_MARKER}`])
  const directory = join(
    f.options.home,
    'steps',
    String(f.ticket.id),
    String(context.attempt.id),
  )
  assert.match(
    await readFile(join(directory, 'writer-1', 'result-error.txt'), 'utf8'),
    /SyntaxError/,
  )
  assert.doesNotMatch(
    await readFile(join(directory, 'writer-2', 'prompt.md'), 'utf8'),
    /previous description/,
  )
  assert.equal(
    (await f.detail()).artifacts.filter((a) => a.kind === 'log').length,
    2,
  )
})

test('maintenance reuses a cached description without wording checks', async (t) => {
  const f = await fixture(t)
  const note = '  [Evidence](http://localhost:4600/api/artifacts/1)  '
  await savePullRequestDescription(f.store.database, f.ticket.id, f.head, note)
  await f.publish()
  assert.equal(f.writers(), 0)
  assert.deepEqual(f.bodies, [`${note}\n\n${FACTORY_MARKER}`])
  assert.equal(
    await getPullRequestDescription(f.store.database, f.ticket.id, f.head),
    note,
  )
})

test('gate is evaluated during CI and merge waits, with checks separate from historical writer text', async (t) => {
  const { getMergeGate } = await import('../src/store/merge-gates.ts')
  const { refreshMergeGate } = await import('../src/engine/merge-gate.ts')
  const f = await fixture(t, true)
  f.setChecks({
    state: 'pending',
    failures: [],
    checks: [
      {
        name: 'build',
        state: 'pending',
        required: true,
        url: 'https://github.com/check',
      },
    ],
  })
  await f.publish()
  let snapshot = (await getMergeGate(f.store.database, f.ticket.id))!
  assert.equal(snapshot.latest.ready, false)
  assert.equal(snapshot.latest.facts.head, f.head)
  assert.equal(snapshot.latest.facts.checks[0]!.state, 'pending')
  f.setChecks({
    state: 'passed',
    failures: [],
    checks: [
      {
        name: 'build',
        state: 'passed',
        required: true,
        url: 'https://github.com/check',
      },
    ],
  })
  await f.poll()
  const context = await f.next()
  await runAttempt(f.options, context, signal)
  const [waiting] = await listWaitingForMerge(f.store.database)
  await refreshMergeGate(f.options, waiting!, signal)
  snapshot = (await getMergeGate(f.store.database, f.ticket.id))!
  assert.equal(snapshot.latest.ready, true)
  assert.equal(snapshot.lastGreen!.facts.head, f.head)
  assert.match(f.bodies[0]!, /CI pending at publication/)
  assert.doesNotMatch(
    f.bodies[0]!,
    /localhost|factory\.example|\/api\/artifacts|\/Users\//,
  )
})

test('open feedback and current consumed change requests both block; behind base preserves earlier green head while rebuilding', async (t) => {
  const { getMergeGate } = await import('../src/store/merge-gates.ts')
  const { refreshMergeGate } = await import('../src/engine/merge-gate.ts')
  const { addAttemptArtifacts } = await import('../src/store/tickets.ts')
  const f = await fixture(t, true)
  f.setChecks({ state: 'passed', failures: [] })
  await f.publish()
  await runAttempt(f.options, await f.next(), signal)
  const [waiting] = await listWaitingForMerge(f.store.database)
  f.setFeedback([
    {
      id: 'review:50',
      author: 'owner',
      url: 'https://github.com/review/50',
      body: 'Fix this',
      changeRequest: true,
      createdAt: new Date().toISOString(),
    },
  ])
  await addAttemptArtifacts(f.store.database, waiting!.attempt.id, [
    {
      kind: 'comment',
      title: 'Consumed review',
      content: '<!-- github-feedback:review:50 -->',
    },
  ])
  const review = await refreshMergeGate(f.options, waiting!, signal)
  assert.match(review.gate.blockers.join(), /feedback/)
  f.setFeedback([
    {
      id: 'comment:51',
      author: 'owner',
      url: 'https://github.com/comment/51',
      body: 'Also fix this',
      createdAt: new Date().toISOString(),
    },
  ])
  assert.match(
    (await refreshMergeGate(f.options, waiting!, signal)).gate.blockers.join(),
    /feedback/,
  )
  f.setFeedback([])
  await f.advanceBase()
  assert.match(
    (await refreshMergeGate(f.options, waiting!, signal)).gate.blockers.join(),
    /Behind base/,
  )
  await pollPullRequestBase(f.options, waiting!, signal)
  const snapshot = (await getMergeGate(f.store.database, f.ticket.id))!
  assert.equal(snapshot.lastGreen!.facts.head, f.head)
  assert.equal((await f.detail()).ticket.status, 'queued')
  await f.publish()
  assert.equal((await f.detail()).attempts.at(-2)!.outcome, 'base-moved')
})

for (const path of [
  '.kipster/kit.yml',
  '.github/workflows/ci.yml',
  'db/migrations/001.sql',
  'custom/001.sql',
]) {
  test(`trusted path rules need the owner for ${path}`, async (t) => {
    const { refreshMergeGate } = await import('../src/engine/merge-gate.ts')
    const f = await fixture(t)
    await mkdir(join(f.source, '.kipster'), { recursive: true })
    await f.commit(
      f.source,
      '.kipster/kit.yml',
      'version: 1\ncheck: true\nmerge:\n  migrations: [custom/*.sql]\n'.replace(
        'check: true',
        'check: "true"',
      ),
    )
    await run('git', ['push', f.bare, 'main'], { cwd: f.source })
    await mkdir(join(f.cwd, path.substring(0, path.lastIndexOf('/'))), {
      recursive: true,
    })
    await f.commit(
      f.cwd,
      path,
      path === '.kipster/kit.yml'
        ? 'version: 1\ncheck: "true"\nmerge:\n  migrations: []\n'
        : 'changed',
    )
    // Avoid a same-file kit merge conflict; bring the trusted baseline into this branch first.
    if (path === '.kipster/kit.yml') {
      await run('git', ['fetch', 'origin'], { cwd: f.cwd })
      await run(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.test',
          'merge',
          '-s',
          'ours',
          '--no-edit',
          'origin/main',
        ],
        { cwd: f.cwd },
      )
    }
    await f.publish()
    const [waiting] = await listWaitingForMerge(
      f.store.database,
      'pull-request-checks',
    )
    const { gate } = await refreshMergeGate(f.options, waiting!, signal)
    assert.ok(gate.paths.some((p) => p.path === path))
    assert.match(
      gate.needsOwner.join(),
      new RegExp(path.replaceAll('.', '\\.')),
    )
    assert.deepEqual(
      gate.facts.migrationGlobs,
      ['custom/*.sql'],
      'ticket kit cannot replace trusted rules',
    )
  })
}

test('writer publishes paraphrased scenarios and unrestricted wording unchanged', async (t) => {
  const { addAttemptArtifacts } = await import('../src/store/tickets.ts')
  const f = await fixture(t, true)
  const scenarios = [
    'Empty checkout succeeds',
    'Repeated checkout is idempotent',
  ]
  const tester = (await f.detail()).attempts[0]!
  await addAttemptArtifacts(
    f.store.database,
    tester.id,
    scenarios.map((scenario) => ({
      kind: 'evidence' as const,
      title: scenario,
      scenario,
      scenarioResult: 'passed' as const,
      content: 'Observed successful checkout at the tested head',
    })),
  )
  const note = `  Submitting a blank basket completes successfully, and submitting it again leaves a single order.
${'Details of the change. '.repeat(220)}
[proof](http://factory.lan:4600/#/tickets/1)
[proof](/api/artifacts/1)
/Users/someone/.kipster-factory/steps
  `
  assert.ok(note.length > 4000)
  writerRuns(f, [{ notes: [note] }])
  const context = await f.publish()
  const prompt = await readFile(
    join(
      f.options.home,
      'steps',
      String(f.ticket.id),
      String(context.attempt.id),
      'writer-1',
      'prompt.md',
    ),
    'utf8',
  )
  for (const scenario of scenarios) {
    assert.ok(prompt.includes(scenario))
    assert.ok(!note.includes(scenario))
  }
  assert.deepEqual(f.bodies, [`${note}\n\n${FACTORY_MARKER}`])
  assert.equal(f.writers(), 1)
  assert.equal(
    (await f.detail()).artifacts.find((a) => a.kind === 'note')!.content,
    note,
  )
})

test('oversized writer note fits GitHub while the full text stays on the ticket', async (t) => {
  const f = await fixture(t)
  const note = '🌻'.repeat(40_000)
  writerRuns(f, [{ notes: [note] }])
  await f.publish()
  const body = f.bodies[0]!
  assert.ok(body.length <= 65_536)
  assert.equal(
    body,
    `${fitGitHubLimit(note, f.ticket.number)}\n\n${FACTORY_MARKER}`,
  )
  assert.ok(
    body.endsWith(
      `Full description on ticket #${f.ticket.number} in the factory\n\n${FACTORY_MARKER}`,
    ),
  )
  assert.equal(
    (await f.detail()).artifacts.find((a) => a.kind === 'note')!.content,
    note,
  )
  assert.equal(
    await getPullRequestDescription(f.store.database, f.ticket.id, f.head),
    fitGitHubLimit(note, f.ticket.number),
  )
  assert.equal(f.writers(), 1)
})

for (const first of [
  { notes: [] },
  { notes: ['  \n\t'] },
  { outcome: 'needs-decision', notes: ['A note with a non-done outcome'] },
]) {
  test(`writer retries no usable note: ${JSON.stringify(first)}`, async (t) => {
    const f = await fixture(t)
    const note = 'Second writer note'
    writerRuns(f, [first, { notes: [note] }])
    const context = await f.publish()
    assert.equal(f.writers(), 2)
    assert.deepEqual(f.bodies, [`${note}\n\n${FACTORY_MARKER}`])
    assert.ok(
      await readFile(
        join(
          f.options.home,
          'steps',
          String(f.ticket.id),
          String(context.attempt.id),
          'writer-1',
          'result-error.txt',
        ),
        'utf8',
      ),
    )
  })
}

test('writer uses the first non-empty note when multiple notes exist', async (t) => {
  const f = await fixture(t)
  writerRuns(f, [
    { notes: [' \n ', '  First usable note  ', 'Second usable note'] },
  ])
  await f.publish()
  assert.equal(f.writers(), 1)
  assert.deepEqual(f.bodies, [`  First usable note  \n\n${FACTORY_MARKER}`])
})

for (const reviewed of [false, true]) {
  test(`two unusable writer runs publish and cache a factory description, reviewed: ${reviewed}`, async (t) => {
    const f = await fixture(t, reviewed, 60, reviewed)
    writerRuns(f, [{ missing: true }, { crash: true }])
    const context = await f.publish()
    assert.equal(f.writers(), 2)
    assert.equal(f.bodies.length, 1)
    const body = f.bodies[0]!
    assert.match(body, /Keep ready/)
    assert.match(body, /Commits:\n- [a-f0-9]+ ticket change/)
    assert.ok(body.includes(`Verified at ${f.head}`))
    assert.ok(
      body.includes(`Evidence on ticket #${f.ticket.number} in the factory`),
    )
    assert.match(body, /writer did not produce a description/)
    if (reviewed) {
      assert.match(body, /Tester verdict: passed — Exact commit verified/)
      assert.match(body, /Reviewer verdict: passed — Exact commit reviewed/)
    } else {
      assert.match(body, /no tester ran/)
      assert.match(body, /no reviewer ran/)
    }
    assert.doesNotMatch(body, /https?:|\/Users\/|\/tmp\//)
    const detail = await f.detail()
    assert.equal(
      detail.ticket.pullRequestUrl,
      'https://github.com/fixture/repo/pull/1',
    )
    const factoryNote = detail.artifacts.find(
      (a) => a.title === 'factory PR description',
    )!
    assert.equal(body, `${factoryNote.content}\n\n${FACTORY_MARKER}`)
    assert.equal(
      await getPullRequestDescription(f.store.database, f.ticket.id, f.head),
      factoryNote.content,
    )
    const directory = join(
      f.options.home,
      'steps',
      String(f.ticket.id),
      String(context.attempt.id),
    )
    assert.match(
      await readFile(join(directory, 'writer-1', 'result-error.txt'), 'utf8'),
      /ENOENT/,
    )
    assert.match(
      await readFile(join(directory, 'writer-2', 'result-error.txt'), 'utf8'),
      /Writer session crashed/,
    )
  })
}

test('cached oversized description also fits GitHub without invoking a writer', async (t) => {
  const f = await fixture(t)
  const note = 'x'.repeat(70_000)
  await savePullRequestDescription(f.store.database, f.ticket.id, f.head, note)
  await f.publish()
  assert.equal(f.writers(), 0)
  assert.deepEqual(f.bodies, [
    `${fitGitHubLimit(note, f.ticket.number)}\n\n${FACTORY_MARKER}`,
  ])
  assert.ok(f.bodies[0]!.length <= 65_536)
})

test('writer abort propagates without retry or fallback', async (t) => {
  const f = await fixture(t)
  const controller = new AbortController()
  const execute = f.options.execute
  f.options.execute = async (invocation) => {
    await execute(invocation)
    controller.abort(new Error('Writer cancelled'))
    throw controller.signal.reason
  }
  const context = await f.next()
  await assert.rejects(
    runAttempt(f.options, context, controller.signal),
    /Writer cancelled/,
  )
  assert.equal(f.writers(), 1)
  assert.equal(f.bodies.length, 0)
  assert.equal(
    await getPullRequestDescription(f.store.database, f.ticket.id, f.head),
    null,
  )
})

test('writer crash after a worktree edit still stops publication', async (t) => {
  const f = await fixture(t)
  const execute = f.options.execute
  f.options.execute = async (invocation) => {
    await execute(invocation)
    await writeFile(
      join(f.cwd, 'unexpected.txt'),
      'Writer changed the worktree',
    )
    throw new Error('Writer crashed')
  }
  await assert.rejects(f.publish(), /writer changed the worktree/)
  assert.equal(f.writers(), 1)
  assert.equal(f.bodies.length, 0)
})

test('GitHub limit preserves short text and UTF-16 pairs at the boundary', () => {
  const suffix = `\n\n${FACTORY_MARKER}`
  const ending = 'Full description on ticket #3 in the factory'
  for (const note of ['  Short text  ', 'x'.repeat(65_536 - suffix.length)])
    assert.equal(fitGitHubLimit(note, 3), note)
  const end = 65_536 - suffix.length - `\n\n${ending}`.length
  const note = 'x'.repeat(end - 1) + '🌻' + 'y'.repeat(200)
  const fitted = fitGitHubLimit(note, 3)
  assert.equal(fitted, 'x'.repeat(end - 1) + `\n\n${ending}`)
  assert.ok(fitted.length + suffix.length <= 65_536)
  assert.equal(fitGitHubLimit('x'.repeat(70_000), 3, 100).length, 65_436)
})

test('factory description lists exposed lead tasks and omits URLs and paths from facts', async (t) => {
  const f = await fixture(t, true, 60, true)
  const detail = await f.detail()
  const body = factoryDescription(
    {
      ...detail,
      ticket: {
        ...detail.ticket,
        title: 'Fix /Users/someone/project https://factory.lan/ticket',
      },
      tasks: [
        {
          id: 1,
          ticketId: f.ticket.id,
          attemptId: detail.attempts[0]!.id,
          key: 'first',
          title: 'First task',
          instructions: '',
          land: 'branch',
          workflow: 'task',
          agent: null,
          status: 'merged',
          decision: null,
          result: null,
          baseCommit: f.head,
          child: null,
          createdAt: '',
          updatedAt: '',
        },
      ],
      attempts: [
        ...detail.attempts,
        {
          ...detail.attempts[0]!,
          id: 99,
          outcome: 'failed',
          summary: 'New verdict http://localhost:4600/proof /tmp/evidence',
        },
        {
          ...detail.attempts[0]!,
          id: 100,
          status: 'running',
          outcome: null,
          summary: null,
        },
      ],
    },
    f.head,
    ['unused commit'],
  )
  assert.match(body, /Tasks:\n- First task \(merged\)/)
  assert.doesNotMatch(body, /Commits:|unused commit|https?:|\/Users\/|\/tmp\//)
  assert.match(body, /Tester verdict: failed — New verdict/)
  assert.match(body, /Reviewer verdict: passed — Exact commit reviewed/)
  const commits = factoryDescription(detail, f.head, ['abc first change'], 7)
  assert.match(commits, /Commits:\n- abc first change\nand 7 more/)
})
