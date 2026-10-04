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
import { createTestStore } from './helpers/store.ts'
import { Workspaces } from '../src/workspace/workspaces.ts'
import { runAttempt, type RunnerOptions } from '../src/engine/runner.ts'
import {
  pollPullRequestChecks,
  pollPullRequestFeedback,
} from '../src/engine/pull-requests.ts'
import { startScheduler } from '../src/engine/scheduler.ts'
import { listenForEvents } from '../src/store/events.ts'

const signal = new AbortController().signal
function entry(workflow: Workflow) {
  const source = JSON.stringify(workflow)
  return { workflow, source, version: workflowVersion(source) }
}
async function fixture(t: TestContext, tester = false, timeout = 60) {
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
        {
          id: 'publish',
          kind: 'system',
          action: 'maintain-pr',
          needs: [],
          with: {
            ciTimeoutMinutes: timeout,
            factoryUrl: 'https://factory.example.test',
          },
          routes: {},
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
    async maintain(input) {
      bodies.push(input.body)
      return { url: 'https://github.com/fixture/repo/pull/1', state: 'OPEN' }
    },
    async inspect() {
      return { url: 'https://github.com/fixture/repo/pull/1', state: 'OPEN' }
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
  assert.match(f.bodies[0]!, /https:\/\/factory.example.test/)
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

test('no checks continues on the first snapshot without waiting for a scheduler poll', async (t) => {
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
  assert.equal(f.checkedHeads.length, 1)
})

test('writer invalid output retries in a fresh session before publication', async (t) => {
  const f = await fixture(t)
  await writeFile(
    join(f.root, 'script.json'),
    JSON.stringify({ writer: [{ invalid: true }, {}] }),
  )
  await f.publish()
  assert.equal(f.writers(), 2)
  assert.equal(f.bodies.length, 1)
  assert.equal(
    (await f.detail()).artifacts.filter((a) => a.kind === 'log').length,
    2,
  )
})
