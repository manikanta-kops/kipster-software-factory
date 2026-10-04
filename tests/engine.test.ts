import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import {
  symlink,
  rename,
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'
import { engineConfig, readConfig } from '../src/config.ts'
import { startScheduler } from '../src/engine/scheduler.ts'
import { cliCommand, type AgentExecutor } from '../src/executors/cli.ts'
import { run } from '../src/executors/process.ts'
import type { GitHub, PullRequest } from '../src/github/github.ts'
import { listenForEvents } from '../src/store/events.ts'
import { acquireSchedulerLock } from '../src/store/scheduler.ts'
import {
  createRepository,
  getRepository,
  markRepositoryReady,
} from '../src/store/repositories.ts'
import {
  cancelTicket,
  claimAttempts,
  createTicket,
  decide,
  getTicketDetail,
  markRunning,
  listTickets,
  resolveAsk,
} from '../src/store/tickets.ts'
import { Workspaces } from '../src/workspace/workspaces.ts'
import { builtInWorkflow, createTestStore } from './helpers/store.ts'

const fixture = fileURLToPath(
  new URL('./fixtures/fake-agent.ts', import.meta.url),
)
async function until<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeout = 15_000,
): Promise<T> {
  const end = Date.now() + timeout
  while (true) {
    const value = await read()
    if (predicate(value)) return value
    if (Date.now() > end)
      throw new Error(`Condition timed out: ${JSON.stringify(value)}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
async function setup(t: TestContext, script: object = {}) {
  const root = await mkdtemp(join(tmpdir(), 'factory-engine-'))
  const home = join(root, 'home')
  await mkdir(home)
  const source = join(root, 'source')
  const bare = join(root, 'origin.git')
  execFileSync('git', ['init', '-b', 'main', source], { stdio: 'ignore' })
  await writeFile(join(source, 'README.md'), 'fixture\n')
  execFileSync('git', ['add', '.'], { cwd: source })
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'Initial',
    ],
    { cwd: source, stdio: 'ignore' },
  )
  execFileSync('git', ['clone', '--bare', source, bare], { stdio: 'ignore' })
  const store = await createTestStore()
  const events = listenForEvents(store.database)
  await events.ready
  const repository = await createRepository(store.database, {
    slug: 'fixture/repo',
    cloneUrl: bare,
  })
  const scriptFile = join(root, 'script.json')
  await writeFile(scriptFile, JSON.stringify(script))
  let current = 0
  let maximum = 0
  const invocations: string[] = []
  const execute: AgentExecutor = async (invocation) => {
    current++
    maximum = Math.max(maximum, current)
    invocations.push(invocation.directory)
    try {
      await run(
        process.execPath,
        [fixture, invocation.directory, scriptFile, root],
        { cwd: invocation.cwd, log: invocation.log, signal: invocation.signal },
      )
    } finally {
      current--
    }
  }
  let state: PullRequest['state'] = 'OPEN'
  const requests: Parameters<GitHub['maintain']>[0][] = []
  let inspections = 0
  const github: GitHub = {
    async checks() {
      return { state: 'none', failures: [] }
    },
    async feedback() {
      return []
    },
    async maintain(input) {
      requests.push(input)
      return { url: 'https://github.com/fixture/repo/pull/1', state }
    },
    async inspect() {
      inspections++
      return { url: 'https://github.com/fixture/repo/pull/1', state }
    },
  }
  const errors: unknown[] = []
  let scheduler: Awaited<ReturnType<typeof startScheduler>> | undefined
  const start = async (config = engineConfig.parse({})) => {
    scheduler = await startScheduler({
      database: store.database,
      events,
      home,
      config,
      execute,
      github,
      fallbackMs: 100,
      mergePollMs: 100,
      onError: (error) => errors.push(error),
    })
    return scheduler
  }
  t.after(async () => {
    await scheduler?.close()
    await events.close()
    await store.close()
    await rm(root, { recursive: true, force: true })
  })
  const ticket = async (title = 'Small change') => {
    await until(
      () => getRepository(store.database, repository.slug),
      (repo) => repo?.status === 'ready',
    )
    return createTicket(store.database, {
      repository: repository.slug,
      title,
      workflow: await builtInWorkflow('quick-change'),
    })
  }
  const detail = async (number: number) =>
    (await getTicketDetail(store.database, number))!
  return {
    root,
    home,
    bare,
    store,
    events,
    repository,
    execute,
    github,
    errors,
    start,
    ticket,
    detail,
    invocations,
    requests,
    maximum: () => maximum,
    inspections: () => inspections,
    setState: (value: PullRequest['state']) => {
      state = value
    },
  }
}

test('quick-change: approval, two builds, review loop, PR, merge wait and terminal cleanup', async (t) => {
  const f = await setup(t, {
    builder: [{ commit: true }, { commit: true }],
    reviewer: [{ outcome: 'changes-needed' }, { outcome: 'passed' }],
  })
  await f.start()
  const ticket = await f.ticket()
  const approval = await until(
    () => f.detail(ticket.number),
    (d) => d.ticket.waiting?.for === 'human',
  )
  assert.equal(approval.artifacts.filter((a) => a.kind === 'plan').length, 1)
  await decide(f.store.database, {
    ticketNumber: ticket.number,
    attemptId: approval.ticket.waiting!.attemptId,
    choice: 'changes-needed',
    comment: 'Revise the original plan.',
  })
  const revised = await until(
    () => f.detail(ticket.number),
    (d) =>
      d.ticket.waiting?.for === 'human' &&
      d.ticket.waiting.attemptId !== approval.ticket.waiting!.attemptId,
  )
  await decide(f.store.database, {
    ticketNumber: ticket.number,
    attemptId: revised.ticket.waiting!.attemptId,
    choice: 'approved',
    comment: 'Use the plan.',
  })
  const waiting = await until(
    () => f.detail(ticket.number),
    (d) => d.ticket.waiting?.for === 'pull-request-merge',
  )
  assert.equal(waiting.attempts.filter((a) => a.stepId === 'build').length, 2)
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0]!.title, ticket.title)
  assert.match(f.requests[0]!.body, /Verified at [a-f0-9]{40}/)
  assert.match(f.requests[0]!.body, /Merge danger: two-way door/)
  assert.doesNotMatch(
    f.requests[0]!.body,
    /Acceptance plan|Verification build|fake reviewer/,
  )
  assert.equal(waiting.artifacts.filter((a) => a.kind === 'log').length, 7)
  const buildPrompt = await readFile(
    join(f.invocations[4]!, 'prompt.md'),
    'utf8',
  )
  assert.match(buildPrompt, /Add a second change file/)
  assert.match(buildPrompt, /Use the plan/)
  assert.match(buildPrompt, /"planApproved": true/)
  assert.match(
    execFileSync(
      'git',
      ['--git-dir', f.bare, 'log', '--oneline', ticket.branch],
      { encoding: 'utf8' },
    ),
    /Build 1/,
  )
  const source = join(f.root, 'source')
  await mkdir(join(source, '.kipster'))
  await writeFile(
    join(source, '.kipster/kit.yml'),
    'version: 1\nsetup: echo ready\ncheck: echo checked\n',
  )
  await run('git', ['add', '.'], { cwd: source })
  await run(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'Merged default-branch kit',
    ],
    { cwd: source },
  )
  await run('git', ['push', f.bare, 'main'], { cwd: source })
  f.setState('MERGED')
  await until(
    () => f.detail(ticket.number),
    (d) => d.ticket.status === 'done',
  )
  await until(
    () => exists(new Workspaces(f.home).path(ticket)),
    (value) => !value,
  )
  assert.deepEqual(
    (await getRepository(f.store.database, f.repository.slug))!.kit,
    { status: 'valid', error: null, capabilities: ['setup'] },
  )
  assert.deepEqual(f.errors, [])
})

test('invalid, missing and wrong-role results retry once then ask, preserving logs', async (t) => {
  for (const entry of [
    { invalid: true },
    { missing: true },
    { outcome: 'passed' },
  ]) {
    await t.test(JSON.stringify(entry), async (subtest) => {
      const f = await setup(subtest, { planner: [entry] })
      await f.start()
      const ticket = await f.ticket()
      const stopped = await until(
        () => f.detail(ticket.number),
        (d) => d.ticket.waiting?.for === 'ask',
      )
      assert.equal(f.invocations.length, 2)
      assert.match(stopped.attempts[0]!.headCommit!, /^[0-9a-f]{40}$/)
      assert.match(stopped.attempts[0]!.error!, /result.json after two runs/)
      assert.equal(stopped.artifacts.filter((a) => a.kind === 'log').length, 2)
    })
  }
})

test('invalid result can recover on the one fresh retry', async (t) => {
  const f = await setup(t, { planner: [{ invalid: true }, {}] })
  await f.start()
  const ticket = await f.ticket()
  await until(
    () => f.detail(ticket.number),
    (d) => d.ticket.waiting?.for === 'human',
  )
  assert.equal(f.invocations.length, 2)
  assert.notEqual(f.invocations[0], f.invocations[1])
})

async function assertDead(pidFile: string) {
  const pid = Number(await readFile(pidFile, 'utf8'))
  await until(async () => {
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  }, Boolean)
}

test('timeout kills agent and its child process and asks the human', async (t) => {
  const f = await setup(t, { planner: [{ wait: true, descendant: true }] })
  await f.start(engineConfig.parse({ stepTimeoutMinutes: 0.03 }))
  const ticket = await f.ticket()
  const detail = await until(
    () => f.detail(ticket.number),
    (d) => d.ticket.waiting?.for === 'ask',
  )
  assert.match(detail.attempts[0]!.error!, /timed out/)
  assert.match(detail.attempts[0]!.headCommit!, /^[0-9a-f]{40}$/)
  await assertDead(join(f.invocations[0]!, 'pid'))
  await assertDead(join(f.invocations[0]!, 'descendant.pid'))
})

test('cancelling a running step kills the whole group without opening an ask', async (t) => {
  const f = await setup(t, { planner: [{ wait: true, descendant: true }] })
  await f.start()
  const ticket = await f.ticket()
  await until(
    async () =>
      f.invocations[0]
        ? exists(join(f.invocations[0], 'descendant.pid'))
        : false,
    Boolean,
  )
  await cancelTicket(f.store.database, { ticketNumber: ticket.number })
  await assertDead(join(f.invocations[0]!, 'pid'))
  await assertDead(join(f.invocations[0]!, 'descendant.pid'))
  assert.equal((await f.detail(ticket.number)).ticket.status, 'cancelled')
})

test('concurrency is bounded and shutdown interrupts work for restart', async (t) => {
  const f = await setup(t, { planner: [{ wait: true }] })
  const scheduler = await f.start()
  const first = await f.ticket('First')
  await f.ticket('Second')
  await f.ticket('Third')
  await until(
    async () => f.invocations.length,
    (value) => value === 2,
  )
  await scheduler.close()
  assert.equal(f.maximum(), 2)
  assert.equal(
    (await f.detail(first.number)).attempts[0]!.status,
    'interrupted',
  )
  await writeFile(join(f.root, 'script.json'), '{}')
  await f.start()
  await until(
    () => f.detail(first.number),
    (d) => d.ticket.waiting?.for === 'human',
  )
})

test('startup recovers an abandoned running attempt and a second process cannot interrupt it', async (t) => {
  const f = await setup(t)
  await markRepositoryReady(f.store.database, f.repository.id)
  const ticket = await f.ticket()
  const [claimed] = await claimAttempts(f.store.database, 1)
  await markRunning(f.store.database, claimed!.attempt.id, 'crashed-process')
  const lock = await acquireSchedulerLock(f.store.database, () => {})
  const lockProbe = fileURLToPath(
    new URL('./fixtures/lock-probe.ts', import.meta.url),
  )
  const result = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [lockProbe, f.store.url], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let text = ''
    child.stdout.on('data', (data) => {
      text += data
    })
    child.stderr.on('data', (data) => {
      text += data
    })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(text) : reject(new Error(text)),
    )
  })
  assert.match(result, /Another factory process/)
  assert.equal((await f.detail(ticket.number)).attempts[0]!.status, 'running')
  await lock.close()
  await f.start()
  const detail = await until(
    () => f.detail(ticket.number),
    (d) => d.ticket.waiting?.for === 'human',
  )
  assert.equal(detail.attempts[0]!.status, 'interrupted')
})

test('no commits asks for a decision; closing an unmerged PR rejects it', async (t) => {
  const f = await setup(t)
  await f.start()
  const ticket = await f.ticket()
  const approval = await until(
    () => f.detail(ticket.number),
    (d) => d.ticket.waiting?.for === 'human',
  )
  await decide(f.store.database, {
    ticketNumber: ticket.number,
    attemptId: approval.ticket.waiting!.attemptId,
    choice: 'approved',
  })
  const ask = await until(
    () => f.detail(ticket.number),
    (d) => d.ticket.waiting?.for === 'ask',
  )
  assert.match(
    ask.ticket.waiting!.summary!,
    /The ticket branch has no commits to publish/,
  )
  assert.equal(f.requests.length, 0)
  await writeFile(
    join(f.root, 'script.json'),
    JSON.stringify({ builder: [{ commit: true }] }),
  )
  await resolveAsk(f.store.database, {
    ticketNumber: ticket.number,
    attemptId: ask.ticket.waiting!.attemptId,
    resolution: { action: 'move', stepId: 'build' },
  })
  await until(
    () => f.detail(ticket.number),
    (d) => d.ticket.waiting?.for === 'pull-request-merge',
  )
  f.setState('CLOSED')
  const rejected = await until(
    () => f.detail(ticket.number),
    (d) => d.ticket.status === 'cancelled',
  )
  assert.equal(rejected.attempts.at(-1)!.outcome, 'rejected')
})

test('configuration defaults and verified CLI argument sets', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'factory-config-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({ databaseUrl: 'postgres://localhost/test' }),
  )
  const config = await readConfig(home)
  assert.equal(config.concurrency, 2)
  assert.equal(config.stepTimeoutMinutes, 60)
  assert.deepEqual(config.agents.default, { cli: 'codex' })
  assert.ok(
    cliCommand({ cli: 'codex' }).args.includes(
      '--dangerously-bypass-approvals-and-sandbox',
    ),
  )
  assert.ok(
    cliCommand({ cli: 'claude', model: 'sonnet' }).args.includes(
      '--dangerously-skip-permissions',
    ),
  )
})

test('SIGKILL of the factory kills orphan agents; restart recovers under the lock', async (t) => {
  const f = await setup(t, { planner: [{ wait: true, descendant: true }] })
  await markRepositoryReady(f.store.database, f.repository.id)
  const ticket = await f.ticket()
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL('./fixtures/scheduler-process.ts', import.meta.url),
      ),
      f.store.url,
      f.home,
      f.root,
    ],
    { stdio: 'ignore' },
  )
  const closed = new Promise((resolve) => child.on('close', resolve))
  t.after(async () => {
    child.kill('SIGKILL')
    await closed
  })
  const started = await until(
    () => f.detail(ticket.number),
    (d) => d.artifacts.some((a) => a.kind === 'log'),
  )
  const directory = join(
    f.home,
    'steps',
    String(ticket.id),
    String(started.attempts[0]!.id),
    '1',
  )
  await until(() => exists(join(directory, 'descendant.pid')), Boolean)
  child.kill('SIGKILL')
  await closed
  await assertDead(join(directory, 'pid'))
  await assertDead(join(directory, 'descendant.pid'))
  await writeFile(join(f.root, 'script.json'), '{}')
  await f.start()
  const recovered = await until(
    () => f.detail(ticket.number),
    (d) => d.ticket.waiting?.for === 'human',
  )
  assert.equal(recovered.attempts[0]!.status, 'interrupted')
})

test('workspace ownership and dirty files survive terminal cleanup', async (t) => {
  const f = await setup(t)
  await markRepositoryReady(f.store.database, f.repository.id)
  const ticket = await f.ticket()
  const workspaces = new Workspaces(f.home)
  const signal = new AbortController().signal
  const cwd = await workspaces.prepare(ticket, f.repository, signal)
  await writeFile(join(cwd, 'valuable-notes.txt'), 'Keep this')
  await workspaces.cleanup(
    { ...ticket, status: 'cancelled' },
    f.repository,
    signal,
  )
  assert.equal(
    await readFile(join(cwd, 'valuable-notes.txt'), 'utf8'),
    'Keep this',
  )
  await rm(join(f.home, 'worktrees', String(ticket.id), 'owner.json'))
  await assert.rejects(
    workspaces.prepare(ticket, f.repository, signal),
    /unowned workspace/,
  )
  await assert.rejects(
    workspaces.cleanup(
      { ...ticket, status: 'cancelled' },
      f.repository,
      signal,
    ),
  )
  assert.equal(await exists(cwd), true)
})

test('clone failure marks a registered repository failed', async (t) => {
  const f = await setup(t)
  const failed = await createRepository(f.store.database, {
    slug: 'fixture/missing',
    cloneUrl: join(f.root, 'does-not-exist'),
  })
  await f.start()
  const repo = await until(
    () => getRepository(f.store.database, failed.slug),
    (r) => r?.status === 'failed',
  )
  assert.match(repo!.lastError!, /git exited/)
})

test('cleanup removes ignored dependencies and build output, preserves unknown state and skips cleaned tickets', async (t) => {
  const f = await setup(t)
  await markRepositoryReady(f.store.database, f.repository.id)
  const ticket = await f.ticket()
  const workspaces = new Workspaces(f.home)
  const signal = new AbortController().signal
  const cwd = await workspaces.prepare(ticket, f.repository, signal)
  await writeFile(
    join(cwd, '.gitignore'),
    'node_modules/\ndist/\n.env\n.local/\n',
  )
  await run('git', ['add', '.gitignore'], { cwd })
  await run(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'Ignore generated files',
    ],
    { cwd },
  )
  for (const folder of ['node_modules', 'dist', '.local']) {
    await mkdir(join(cwd, folder))
    await writeFile(join(cwd, folder, 'keep.txt'), folder)
  }
  await writeFile(join(cwd, '.env'), 'secret')
  const terminal = { ...ticket, status: 'cancelled' as const }
  assert.equal(await workspaces.cleanup(terminal, f.repository, signal), false)
  assert.equal(await exists(join(cwd, 'node_modules')), false)
  assert.equal(await exists(join(cwd, 'dist')), false)
  assert.equal(await readFile(join(cwd, '.env'), 'utf8'), 'secret')
  assert.equal(
    await readFile(join(cwd, '.local', 'keep.txt'), 'utf8'),
    '.local',
  )
  await rm(join(cwd, '.env'))
  await rm(join(cwd, '.local'), { recursive: true })
  await cancelTicket(f.store.database, { ticketNumber: ticket.number })
  await f.start()
  await until(
    () => exists(cwd),
    (present) => !present,
  )
  await until(
    () =>
      listTickets(f.store.database, {
        status: ['cancelled'],
        cleanupPending: true,
      }),
    (tickets) => tickets.length === 0,
  )
  assert.equal(await exists(workspaces.cache(f.repository)), true)
  assert.equal(await workspaces.cleanup(terminal, f.repository, signal), true)
})

test('cleanup preserves locked worktrees and ignored symlinks', async (t) => {
  const f = await setup(t)
  await markRepositoryReady(f.store.database, f.repository.id)
  const ticket = await f.ticket()
  const workspaces = new Workspaces(f.home)
  const signal = new AbortController().signal
  const cwd = await workspaces.prepare(ticket, f.repository, signal)
  await writeFile(join(cwd, '.gitignore'), 'dist/\nnode_modules\n')
  await run('git', ['add', '.gitignore'], { cwd })
  await run(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'Ignore output',
    ],
    { cwd },
  )
  await mkdir(join(cwd, 'dist'))
  await writeFile(join(cwd, 'dist', 'output'), 'output')
  await run('git', ['worktree', 'lock', cwd], {
    cwd: workspaces.cache(f.repository),
  })
  const terminal = { ...ticket, status: 'done' as const }
  assert.equal(await workspaces.cleanup(terminal, f.repository, signal), false)
  assert.equal(await exists(join(cwd, 'dist', 'output')), true)
  await run('git', ['worktree', 'unlock', cwd], {
    cwd: workspaces.cache(f.repository),
  })
  await symlink(f.root, join(cwd, 'node_modules'))
  assert.equal(await workspaces.cleanup(terminal, f.repository, signal), false)
  assert.equal(
    await readFile(join(f.root, 'source', 'README.md'), 'utf8'),
    'fixture\n',
  )
})

test('registration discovers a non-main default branch and retries repair old registrations', async (t) => {
  const f = await setup(t)
  await run('git', ['branch', '-m', 'main', 'next'], { cwd: f.bare })
  await f.start()
  const ticket = await f.ticket()
  await until(
    () => f.detail(ticket.number),
    (d) => d.ticket.waiting?.for === 'human',
  )
  assert.equal(
    (await getRepository(f.store.database, f.repository.slug))?.defaultBranch,
    'next',
  )
  await markRepositoryReady(f.store.database, f.repository.id, {
    defaultBranch: 'main',
  })
  const second = await f.ticket('Repair legacy registration')
  await until(
    () => f.detail(second.number),
    (d) => d.ticket.waiting?.for === 'human',
  )
  assert.equal(
    (await getRepository(f.store.database, f.repository.slug))?.defaultBranch,
    'next',
  )
})

test('cleanup never follows a replaced worktree root symlink', async (t) => {
  const f = await setup(t)
  await markRepositoryReady(f.store.database, f.repository.id)
  const ticket = await f.ticket()
  const workspaces = new Workspaces(f.home)
  const signal = new AbortController().signal
  const cwd = await workspaces.prepare(ticket, f.repository, signal)
  await writeFile(join(cwd, '.gitignore'), 'dist/\n')
  await run('git', ['add', '.gitignore'], { cwd })
  await run(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'Ignore output',
    ],
    { cwd },
  )
  await mkdir(join(cwd, 'dist'))
  await writeFile(join(cwd, 'dist', 'keep'), 'external output')
  const moved = join(f.root, 'moved-worktree')
  await rename(cwd, moved)
  await symlink(moved, cwd)
  assert.equal(
    await workspaces.cleanup(
      { ...ticket, status: 'cancelled' },
      f.repository,
      signal,
    ),
    false,
  )
  assert.equal(
    await readFile(join(moved, 'dist', 'keep'), 'utf8'),
    'external output',
  )
})

for (const failure of [false, true]) {
  test(`verify-kit ${failure ? 'failed routes to write-kit with stage finding' : 'passed reaches approval at exact ticket commit'}`, async (t) => {
    const f = await setup(t)
    const workspaces = new Workspaces(f.home)
    const signal = new AbortController().signal
    await workspaces.prepareRepository(f.repository, signal)
    const repository = await markRepositoryReady(
      f.store.database,
      f.repository.id,
    )
    const ticket = await createTicket(f.store.database, {
      repository: repository.slug,
      title: 'Onboard fixture',
      workflow: await builtInWorkflow('onboard-repo'),
    })
    const cwd = await workspaces.prepare(ticket, repository, signal)
    await mkdir(join(cwd, '.kipster/verify/features'), { recursive: true })
    await writeFile(
      join(cwd, 'app.ts'),
      await readFile(
        new URL('./fixtures/verification-app.ts', import.meta.url),
      ),
    )
    await writeFile(
      join(cwd, '.kipster/kit.yml'),
      `version: 1\nsetup: echo setup-stage\ncheck: ${failure ? 'echo broken-gate; exit 6' : 'echo check-stage'}\nverify:\n  start: ${process.execPath} app.ts {port} {databaseUrl}\n  ready: http://127.0.0.1:{port}/health\n  ports: 1\n  database: none\n  timeoutSeconds: 5\n`,
    )
    await writeFile(
      join(cwd, '.kipster/verify/README.md'),
      'Use the provided URL; capture evidence under evidenceDir.',
    )
    await writeFile(
      join(cwd, '.kipster/verify/features/health.md'),
      '## Sub-features\nHealth\n## How to get to it (user point of view)\nOpen health\n## Driving it\n| User action | Exact command | Observable result |\n| --- | --- | --- |\n| Open | curl "$APP_URL/health" | HTTP 200 |\n## Gotchas\nNone\n',
    )
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
        'Candidate kit',
      ],
      { cwd },
    )
    const commit = await run('git', ['rev-parse', 'HEAD'], { cwd })
    const { completeAttempt } = await import('../src/store/tickets.ts')
    const { runAttempt } = await import('../src/engine/runner.ts')
    for (let round = 0; round < (failure ? 3 : 1); round++) {
      const [write] = await claimAttempts(f.store.database, 1)
      assert.equal(write?.step.id, 'write-kit')
      await markRunning(f.store.database, write.attempt.id, 'codex')
      await completeAttempt(
        f.store.database,
        write.attempt.id,
        { outcome: 'done', summary: 'Candidate committed', artifacts: [] },
        { headCommit: commit },
      )
      const [verify] = await claimAttempts(f.store.database, 1)
      assert.equal(verify?.step.id, 'verify-kit')
      await markRunning(f.store.database, verify.attempt.id, 'system')
      await runAttempt(
        {
          database: f.store.database,
          home: f.home,
          workspaces,
          config: engineConfig.parse({}),
          execute: f.execute,
          github: f.github,
        },
        verify,
        signal,
      )
      const detail = await f.detail(ticket.number)
      const attempt = detail.attempts.find((a) => a.id === verify.attempt.id)!
      assert.equal(attempt.outcome, failure ? 'failed' : 'passed')
      assert.equal(attempt.headCommit, commit)
      const logs = detail.artifacts.filter(
        (a) => a.attemptId === attempt.id && a.kind === 'log',
      )
      assert.equal(logs.length, failure ? 2 : 3)
      assert.ok(logs.every((a) => a.mediaType === 'text/plain'))
      if (failure) {
        const finding = detail.artifacts.findLast((a) => a.kind === 'finding')!
        assert.match(finding.content!, /check.*failed/)
        assert.match(finding.content!, /broken-gate/)
        if (round < 2) assert.equal(detail.ticket.currentStep, 'write-kit')
        else assert.equal(detail.ticket.waiting?.askReason, 'limit')
      } else assert.equal(detail.ticket.waiting?.stepId, 'approve-kit')
    }
    assert.deepEqual(
      (await getRepository(f.store.database, repository.slug))!.capabilities,
      [],
    )
    assert.equal(await run('git', ['status', '--porcelain'], { cwd }), '')
    assert.equal(await run('git', ['rev-parse', 'HEAD'], { cwd }), commit)
  })
}
