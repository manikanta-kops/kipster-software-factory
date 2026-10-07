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
import { createGitHub, type GitHub } from '../src/github/github.ts'
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
  checksResult,
  pollPullRequestChecks,
  pollPullRequestBase,
  pollPullRequestFeedback,
} from '../src/engine/pull-requests.ts'
import { startScheduler } from '../src/engine/scheduler.ts'
import { listenForEvents } from '../src/store/events.ts'
import { FACTORY_MARKER } from '../src/github/feedback.ts'
import {
  factoryDescription,
  fitGitHubLimit,
  openFindingsNotice,
  withUntestedNotice,
  writePullRequest,
} from '../src/engine/pr-writer.ts'
import {
  getPullRequestDescription,
  savePullRequestDescription,
} from '../src/store/pull-requests.ts'

const signal = new AbortController().signal
function entry(workflow: Workflow) {
  const source = JSON.stringify(workflow)
  return { workflow, source, version: workflowVersion(source) }
}
async function fixture(t: TestContext, tester = false, reviewer = false) {
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
          with: { ciSettleMinutes: 0 },
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
  await workspaces.prepareRepository(repository, signal)
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
    // Both guards requeue the same maintenance, so its result is checked once.
    if (state === 'pending') return
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

test('zero settle window permits no checks on the first snapshot; base advances during owner merge wait queue the previous maintenance step exactly once', async (t) => {
  const f = await fixture(t)
  f.setChecks({ state: 'none', failures: [] })
  await f.publish()
  const published = await f.detail()
  assert.equal(published.attempts[0]!.outcome, 'ready')
  assert.equal(published.ticket.currentStep, 'merge')
  assert.equal(
    (await listWaitingForMerge(f.store.database, 'pull-request-checks')).length,
    0,
  )
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

test('a reviewed workflow without a tester refreshes stale review after base sync it already published', async (t) => {
  const f = await fixture(t, false, true)
  f.setChecks({ state: 'none', failures: [] })
  await f.publish()
  await runAttempt(f.options, await f.next(), signal)
  const [waiting] = await listWaitingForMerge(f.store.database)
  await f.advanceBase()
  // The branch already contains the new base, so only the stale review requeues maintenance.
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
    assert.equal(await beginBaseSync(f.store.database, f.ticket.id, 3), true)
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
  assert.equal(
    await baseSyncCount(f.store.database, f.ticket.id),
    3,
    'a maintenance with no missing base is not a re-sync',
  )
})

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
  assert.equal(
    await baseSyncCount(f.store.database, f.ticket.id),
    0,
    'a base merge before the first publication is not a re-sync',
  )
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

test('CI pending → failed: a non-required check failing after required checks pass persists the exact commit and its excerpt', async (t) => {
  const f = await fixture(t, true)
  const url = 'https://github.com/fixture/repo/actions/runs/7/job/99'
  let finished = false
  // The real adapter parses GitHub's answer; only the gh process is replaced.
  f.options.github.checks = createGitHub(async (_command, args) => {
    if (args[0] === 'run') return 'Bundle exceeds 500 kB: dist/app.js'
    if (args.includes('--slurp')) return '[[]]'
    const head = args.find((a) => a.startsWith('sha='))!.slice(4)
    return JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            headRefOid: head,
            baseRefName: 'main',
            baseRef: {
              branchProtectionRule: {
                requiredStatusCheckContexts: ['build'],
              },
            },
          },
          object: {
            statusCheckRollup: {
              contexts: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  {
                    kind: 'CheckRun',
                    name: 'build',
                    isRequired: true,
                    status: finished ? 'COMPLETED' : 'QUEUED',
                    conclusion: finished ? 'SUCCESS' : null,
                  },
                  {
                    kind: 'CheckRun',
                    name: 'Bundle',
                    isRequired: false,
                    status: finished ? 'COMPLETED' : 'QUEUED',
                    conclusion: finished ? 'FAILURE' : null,
                    databaseId: 99,
                    detailsUrl: url,
                  },
                ],
              },
            },
          },
        },
      },
    })
  }).checks
  await f.publish()
  await f.poll()
  assert.equal((await f.detail()).ticket.waiting?.for, 'pull-request-checks')
  finished = true
  await f.poll()
  const d = await f.detail()
  const publish = d.attempts.find((a) => a.stepId === 'publish')!
  assert.equal(publish.headCommit, f.head)
  assert.equal(publish.outcome, 'ci-failed')
  assert.equal(publish.summary, 'CI failed: Bundle')
  assert.equal(
    d.artifacts.find((a) => a.kind === 'finding')!.content,
    `[Bundle](${url})\n\nBundle exceeds 500 kB: dist/app.js`,
  )
  const gate = (await getSavedMergeGate(f.store.database, f.ticket.id))!
  assert.equal(gate.latest.facts.ci, 'failed')
  assert.ok(gate.latest.blockers.includes('CI failed'))
})

test('CI pending → timeout asks the owner with the exact commit', async (t) => {
  const f = await fixture(t)
  f.setChecks({ state: 'pending', failures: [] })
  await f.publish()
  await f.store.database.query(
    "UPDATE attempts SET waiting_since = now() - interval '61 minutes' WHERE ticket_id = $1 AND status = 'waiting'",
    [f.ticket.id],
  )
  await f.poll()
  const d = await f.detail()
  assert.equal(d.attempts[0]!.headCommit, f.head)
  assert.equal(d.attempts[0]!.outcome, 'needs-decision')
  assert.equal(d.ticket.waiting?.for, 'ask')
})

test('a head-changed snapshot needs a decision; pending waits; finished checks are ready', () => {
  const url = 'https://github.com/fixture/repo/pull/1'
  assert.deepEqual(checksResult({ state: 'head-changed', failures: [] }, url), {
    outcome: 'needs-decision',
    summary:
      'The pull request head changed on GitHub; reconcile the branch before retrying maintain-pr.',
    artifacts: [],
  })
  assert.equal(checksResult({ state: 'pending', failures: [] }, url), null)
  assert.deepEqual(checksResult({ state: 'none', failures: [] }, url), {
    outcome: 'ready',
    summary: `Pull request: ${url}. No checks configured.`,
    artifacts: [],
  })
  assert.equal(
    checksResult({ state: 'passed', failures: [] }, url)!.summary,
    `Pull request: ${url}. CI passed.`,
  )
})

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

test('gate is evaluated during CI and merge waits; open feedback and current consumed change requests both block; behind base preserves earlier green head while rebuilding', async (t) => {
  const { getMergeGate } = await import('../src/store/merge-gates.ts')
  const { refreshMergeGate } = await import('../src/engine/merge-gate.ts')
  const { addAttemptArtifacts } = await import('../src/store/tickets.ts')
  const f = await fixture(t, true)
  const check = (state: 'pending' | 'passed') => ({
    name: 'build',
    state,
    required: true,
    url: 'https://github.com/check',
  })
  f.setChecks({ state: 'pending', failures: [], checks: [check('pending')] })
  await f.publish()
  let snapshot = (await getMergeGate(f.store.database, f.ticket.id))!
  assert.equal(snapshot.latest.ready, false)
  assert.equal(snapshot.latest.facts.head, f.head)
  assert.equal(snapshot.latest.facts.checks[0]!.state, 'pending')
  f.setChecks({ state: 'passed', failures: [], checks: [check('passed')] })
  await f.poll()
  await runAttempt(f.options, await f.next(), signal)
  const [waiting] = await listWaitingForMerge(f.store.database)
  await refreshMergeGate(f.options, waiting!, signal)
  snapshot = (await getMergeGate(f.store.database, f.ticket.id))!
  assert.equal(snapshot.latest.ready, true)
  assert.equal(snapshot.lastGreen!.facts.head, f.head)
  // The gate reads live checks; the writer's text stays as it was at publication.
  assert.match(f.bodies[0]!, /CI pending at publication/)
  assert.doesNotMatch(
    f.bodies[0]!,
    /localhost|factory\.example|\/api\/artifacts|\/Users\//,
  )
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
  snapshot = (await getMergeGate(f.store.database, f.ticket.id))!
  assert.equal(snapshot.lastGreen!.facts.head, f.head)
  assert.equal((await f.detail()).ticket.status, 'queued')
})

test('trusted path rules need the owner for a ticket kit edit and the trusted custom migration glob', async (t) => {
  const { refreshMergeGate } = await import('../src/engine/merge-gate.ts')
  const f = await fixture(t)
  await mkdir(join(f.source, '.kipster'), { recursive: true })
  await f.commit(
    f.source,
    '.kipster/kit.yml',
    'version: 1\ncheck: "true"\nmerge:\n  migrations: [custom/*.sql]\n',
  )
  await run('git', ['push', f.bare, 'main'], { cwd: f.source })
  await mkdir(join(f.cwd, 'custom'))
  await f.commit(f.cwd, 'custom/001.sql', 'changed')
  // The ticket kit drops the custom glob; only the trusted base kit may still match it.
  await mkdir(join(f.cwd, '.kipster'))
  await f.commit(
    f.cwd,
    '.kipster/kit.yml',
    'version: 1\ncheck: "true"\nmerge:\n  migrations: []\n',
  )
  // Avoid a same-file kit merge conflict; bring the trusted baseline into this branch first.
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
  await f.publish()
  const [waiting] = await listWaitingForMerge(
    f.store.database,
    'pull-request-checks',
  )
  const { gate } = await refreshMergeGate(f.options, waiting!, signal)
  for (const path of ['.kipster/kit.yml', 'custom/001.sql']) {
    assert.ok(gate.paths.some((p) => p.path === path))
    assert.match(
      gate.needsOwner.join(),
      new RegExp(path.replaceAll('.', '\\.')),
    )
  }
  assert.deepEqual(
    gate.facts.migrationGlobs,
    ['custom/*.sql'],
    'ticket kit cannot replace trusted rules',
  )
})

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
    const f = await fixture(t, reviewed, reviewed)
    writerRuns(
      f,
      reviewed
        ? [{ missing: true }, { crash: true }]
        : [
            { notes: [] },
            {
              outcome: 'needs-decision',
              notes: ['A note with a non-done outcome'],
            },
          ],
    )
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
      reviewed ? /ENOENT/ : /no non-empty inline note/,
    )
    assert.match(
      await readFile(join(directory, 'writer-2', 'result-error.txt'), 'utf8'),
      reviewed ? /Writer session crashed/ : /Writer outcome needs-decision/,
    )
  })
}

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
  const f = await fixture(t, true, true)
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

test('open review findings stay short even with long finding text', () => {
  const notice = openFindingsNotice(
    Array.from({ length: 30 }, (_, index) => ({
      title: `Finding ${index} ${'x'.repeat(190)}`,
      file: 'src/app.ts',
    })),
  )
  assert.match(notice, /Open review findings/)
  assert.match(notice, /further findings/)
  assert.ok(notice.length < 4000)
})

for (const source of ['writer', 'cached', 'fallback'] as const) {
  for (const oversized of [false, true]) {
    test(`${source} description gets factory notices before trimming, oversized: ${oversized}`, async (t) => {
      const { addAttemptArtifacts } = await import('../src/store/tickets.ts')
      const f = await fixture(t, true, true)
      const detail = await f.detail()
      const tester = detail.attempts.find(
        (attempt) => attempt.stepId === 'test',
      )!
      const reviewer = detail.attempts.find(
        (attempt) => attempt.stepId === 'review',
      )!
      const scenarios = [
        'Empty checkout succeeds',
        'Repeated checkout is idempotent',
      ]
      await addAttemptArtifacts(
        f.store.database,
        tester.id,
        scenarios.map((scenario) => ({
          kind: 'evidence' as const,
          title: scenario,
          scenario,
          scenarioResult: 'passed' as const,
          content: 'Observed a successful checkout at the tested head',
        })),
      )
      const finding = {
        title: 'Check basket behavior',
        file: 'src/basket.ts',
        content: 'A correction remains open.',
      }
      await addAttemptArtifacts(f.store.database, reviewer.id, [
        { kind: 'finding', ...finding },
      ])
      // Exercise the writer with facts from an unresolved review and a skipped proof step.
      await f.store.database.query(
        "UPDATE attempts SET outcome = 'changes-needed' WHERE id = $1",
        [reviewer.id],
      )
      await f.store.database.query(
        'UPDATE tickets SET skipped_steps = $1 WHERE id = $2',
        [
          JSON.stringify([
            { stepId: 'unavailable-proof', missingCapabilities: ['verify'] },
          ]),
          f.ticket.id,
        ],
      )
      const reason =
        'Untested: no verify capability (skipped unavailable-proof)'
      // Writer wording is published unchanged: long text, URLs and local paths included.
      const note = `  Submitting a blank basket completes successfully, and submitting it again leaves a single order.
${'Details of the change. '.repeat(220)}
[proof](http://factory.lan:4600/#/tickets/1)
[proof](/api/artifacts/1)
/Users/someone/.kipster-factory/steps
${oversized ? '🌻'.repeat(40_000) : ''}  `
      assert.ok(note.length > 4000)
      if (source === 'cached')
        await savePullRequestDescription(
          f.store.database,
          f.ticket.id,
          f.head,
          note,
        )
      else if (source === 'writer') writerRuns(f, [{ notes: [note] }])
      else {
        writerRuns(f, [{ missing: true }, { crash: true }])
        if (oversized)
          await f.store.database.query(
            'UPDATE tickets SET title = $1 WHERE id = $2',
            ['x'.repeat(70_000), f.ticket.id],
          )
      }
      const context = await f.next()
      const body = await writePullRequest(
        f.options,
        context,
        f.cwd,
        f.head,
        signal,
      )
      const saved = await getPullRequestDescription(
        f.store.database,
        f.ticket.id,
        f.head,
      )
      const artifact = (await f.detail()).artifacts.find(
        (a) =>
          a.title ===
          (source === 'fallback' ? 'factory PR description' : 'PR description'),
      )
      const full =
        source === 'fallback'
          ? artifact!.content!
          : withUntestedNotice(note, [reason]) + openFindingsNotice([finding])
      assert.ok(full.includes(reason))
      assert.match(full, /## Open review findings/)
      assert.match(full, /Check basket behavior \(src\/basket.ts\)/)
      assert.equal(body, fitGitHubLimit(full, f.ticket.number))
      assert.ok(body.length + `\n\n${FACTORY_MARKER}`.length <= 65_536)
      assert.equal(
        f.writers(),
        source === 'cached' ? 0 : source === 'writer' ? 1 : 2,
      )
      if (source === 'cached') {
        assert.equal(saved, full)
        assert.equal(
          await writePullRequest(f.options, context, f.cwd, f.head, signal),
          body,
        )
        assert.equal(
          await getPullRequestDescription(
            f.store.database,
            f.ticket.id,
            f.head,
          ),
          full,
        )
      } else {
        assert.equal(artifact!.content, full)
        assert.equal(saved, body)
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
        assert.ok(prompt.includes(reason))
        assert.match(
          prompt,
          /Maximum description length before the factory adds open findings:/,
        )
        assert.match(prompt, /Open review findings:/)
      }
    })
  }
}
