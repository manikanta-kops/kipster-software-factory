import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { TestContext } from 'node:test'
import { engineConfig } from '../../src/config.ts'
import { run } from '../../src/executors/process.ts'
import { Workspaces } from '../../src/workspace/workspaces.ts'
import { workflowVersion } from '../../src/library/library.ts'
import type { Workflow } from '../../src/domain/workflow.ts'
import {
  createRepository,
  markRepositoryReady,
  setAutoMerge,
} from '../../src/store/repositories.ts'
import {
  claimAttempts,
  completeAttempt,
  createTicket,
  getTicketDetail,
  listWaitingForMerge,
  markRunning,
  setPullRequestUrl,
  waitForPullRequestMerge,
} from '../../src/store/tickets.ts'
import { setArtifactHome } from '../../src/store/database.ts'
import { runAttempt, type RunnerOptions } from '../../src/engine/runner.ts'
import type { Checks } from '../../src/github/checks.ts'
import { createGitHub, type PullRequest } from '../../src/github/github.ts'
import { builtInWorkflow, createTestStore } from './store.ts'

interface FixtureSettings {
  path?: string
  tester?: boolean
  reviewer?: boolean
  ownerReview?: string
  settle?: number
  maxBaseSyncs?: number
  /** Runs the built-in task-pr workflow, starting with a finished build. */
  taskPr?: boolean
  /** Answers check inspection through the real adapter instead of fixed Checks. */
  gh?: typeof run
  /** The CI snapshot the fixture's own publication sees; passed by default. */
  checks?: Checks
}

function fixtureWorkflow(settings: FixtureSettings): Workflow {
  return {
    name: 'auto-test',
    description: 'Auto merge fixture',
    steps: [
      ...(settings.tester === false
        ? []
        : [
            {
              id: 'test',
              kind: 'agent' as const,
              role: 'tester' as const,
              needs: [],
              routes: {},
            },
          ]),
      ...(settings.reviewer === false
        ? []
        : [
            {
              id: 'review',
              kind: 'agent' as const,
              role: 'reviewer' as const,
              needs: [],
              routes: {},
            },
          ]),
      {
        id: 'publish',
        kind: 'system',
        action: 'maintain-pr',
        needs: [],
        with: {
          ciSettleMinutes: settings.settle ?? 0,
          maxBaseSyncs: settings.maxBaseSyncs ?? 3,
        },
        routes: { 'base-moved': settings.tester === false ? 'ask' : 'test' },
      },
      {
        id: 'merge',
        kind: 'system',
        action: 'merge',
        with: {},
        needs: [],
        routes: {},
      },
    ],
  }
}

export async function autoMergeFixture(
  t: TestContext,
  settings: FixtureSettings = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'ksf-auto-'))
  const home = join(root, 'home'),
    source = join(root, 'source'),
    bare = join(root, 'origin.git')
  await mkdir(home)
  await run('git', ['init', '-b', 'main', source])
  const commit = async (cwd: string, path: string, content: string) => {
    await mkdir(dirname(join(cwd, path)), { recursive: true })
    await writeFile(join(cwd, path), content)
    await run('git', ['add', '.'], { cwd })
    await run(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@test',
        'commit',
        '-m',
        'Fixture change',
      ],
      { cwd },
    )
    return run('git', ['rev-parse', 'HEAD'], { cwd })
  }
  await commit(source, 'README.md', 'Base\n')
  await commit(
    source,
    '.kipster/kit.yml',
    'version: 1\ncheck: node -e "process.exit(0)"\n',
  )
  await run('git', ['clone', '--bare', source, bare])
  const store = await createTestStore()
  const registered = await createRepository(store.database, {
    slug: 'fixture/auto',
    cloneUrl: bare,
  })
  const repository = await markRepositoryReady(store.database, registered.id)
  await setAutoMerge(store.database, repository.id, true)
  const workflow = fixtureWorkflow(settings)
  const sourceWorkflow = JSON.stringify(workflow)
  const ticket = await createTicket(store.database, {
    repository: repository.slug,
    title: 'A useful change',
    workflow: settings.taskPr
      ? await builtInWorkflow('task-pr')
      : {
          workflow,
          source: sourceWorkflow,
          version: workflowVersion(sourceWorkflow),
        },
  })
  const workspaces = new Workspaces(home)
  const signal = AbortSignal.timeout(30_000)
  await workspaces.prepareRepository(repository, signal)
  const cwd = await workspaces.prepare(ticket, repository, signal)
  let head = await commit(
    cwd,
    settings.path ?? 'ui.ts',
    'export const label = "Last 10 minutes"\n',
  )
  let checks: Checks = settings.checks ?? { state: 'passed', failures: [] }
  let postChecks: Checks = { state: 'passed', failures: [] }
  let pr: PullRequest = {
    url: 'https://github.com/fixture/auto/pull/7',
    state: 'OPEN',
    headRefOid: head,
    baseRefName: 'main',
    isDraft: false,
    mergeable: 'MERGEABLE',
  }
  let merges = 0,
    requests = 0,
    enabledKey = true
  let onInspect: (() => Promise<void>) | undefined
  const server = createServer((_req, res) => {
    requests++
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'The merge path must not call TypeSafe' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const options: RunnerOptions = {
    database: store.database,
    home,
    config: engineConfig.parse({}),
    workspaces,
    decisions: {
      secrets: { get: async () => (enabledKey ? 'fixture-key' : null) },
      transport: {
        baseURL: `http://127.0.0.1:${address.port}`,
        retry: { maxRetries: 0 },
      },
    },
    execute: async (invocation) => {
      const observedHead = await run('git', ['rev-parse', 'HEAD'], {
        cwd: invocation.cwd,
      })
      await writeFile(
        join(invocation.directory, 'result.json'),
        JSON.stringify({
          outcome: 'done',
          summary: 'Writer ready',
          artifacts: [
            {
              kind: 'note',
              title: 'PR description',
              content: `Clarify an existing label. Verified at ${observedHead}. Evidence on ticket #${ticket.number} in the factory. Merge danger: two-way door; one label.`,
            },
          ],
        }),
      )
    },
    github: {
      maintain: async () => pr,
      inspect: async () => {
        await onInspect?.()
        return { ...pr }
      },
      checks: settings.gh
        ? createGitHub(settings.gh).checks
        : async () => checks,
      feedback: async () => [],
      commitChecks: async () => postChecks,
      merge: async (_repository, _url, matchHead) => {
        assert.equal(matchHead, pr.headRefOid)
        merges++
        pr = { ...pr, state: 'MERGED', mergeCommit: { oid: head } }
      },
    },
  }
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await store.close()
    await rm(root, { recursive: true, force: true })
  })
  const next = async () => {
    const [context] = await claimAttempts(store.database, 1)
    assert.ok(context)
    await markRunning(store.database, context.attempt.id, 'system')
    return context
  }
  const pass = async () => {
    const context = await next()
    await completeAttempt(
      store.database,
      context.attempt.id,
      {
        outcome: 'passed',
        summary: 'Independent verdict',
        ...(context.step.kind === 'agent' &&
        context.step.role === 'reviewer' &&
        settings.ownerReview
          ? { ownerReview: { reason: settings.ownerReview } }
          : {}),
        artifacts: [],
      },
      { headCommit: head },
    )
  }
  if (settings.taskPr) {
    const build = await next()
    await completeAttempt(
      store.database,
      build.attempt.id,
      { outcome: 'done', summary: 'Built the change', artifacts: [] },
      { headCommit: head },
    )
  }
  if (settings.tester !== false) await pass()
  if (settings.reviewer !== false) await pass()
  await runAttempt(options, await next(), signal)
  if (
    (await getTicketDetail(store.database, ticket.number))!.ticket
      .currentStep === 'merge'
  )
    await runAttempt(options, await next(), signal)
  return {
    root,
    source,
    bare,
    home,
    cwd,
    store,
    repository,
    ticket,
    options,
    signal,
    commit,
    pass,
    next,
    head: () => head,
    merges: () => merges,
    requests: () => requests,
    detail: async () => (await getTicketDetail(store.database, ticket.number))!,
    context: async () => (await listWaitingForMerge(store.database))[0]!,
    setChecks: (value: Checks) => {
      checks = value
    },
    setPostChecks: (value: Checks) => {
      postChecks = value
    },
    noKey: () => {
      enabledKey = false
    },
    pr: () => ({ ...pr }),
    onInspect: (callback: () => Promise<void>) => {
      onInspect = callback
    },
    setPR: (patch: Partial<PullRequest>) => {
      pr = { ...pr, ...patch }
    },
    newHead: async () => {
      head = await commit(cwd, 'late.ts', 'late change')
      pr = { ...pr, headRefOid: head }
      await run('git', ['push', 'origin', ticket.branch], { cwd })
      return head
    },
  }
}

/**
 * The auto-merge fixture's ticket and database without Git, a publication or a
 * merge step, for tests that need only stored attempts and a factory home.
 */
export async function autoMergeStoreFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ksf-auto-store-'))
  const home = join(root, 'home')
  const store = await createTestStore()
  t.after(async () => {
    await store.close()
    await rm(root, { recursive: true, force: true })
  })
  setArtifactHome(store.database, home)
  const registered = await createRepository(store.database, {
    slug: 'fixture/auto',
  })
  const repository = await markRepositoryReady(store.database, registered.id)
  const source = JSON.stringify(fixtureWorkflow({}))
  const ticket = await createTicket(store.database, {
    repository: repository.slug,
    title: 'A useful change',
    workflow: {
      workflow: fixtureWorkflow({}),
      source,
      version: workflowVersion(source),
    },
  })
  // Published steps leave this directory behind; evidence tests compare its contents.
  await mkdir(join(home, 'evidence', String(ticket.id)), { recursive: true })
  const head = 'c'.repeat(40)
  const url = 'https://github.com/fixture/auto/pull/7'
  let postChecks: Checks = { state: 'passed', failures: [] }
  const unexpected = async (): Promise<never> => {
    throw new Error('The store fixture has no Git or pull request')
  }
  const options: RunnerOptions = {
    database: store.database,
    home,
    config: engineConfig.parse({}),
    workspaces: new Workspaces(home),
    execute: unexpected,
    github: {
      maintain: unexpected,
      inspect: unexpected,
      checks: unexpected,
      feedback: unexpected,
      merge: unexpected,
      commitChecks: async () => postChecks,
    },
  }
  const next = async () => {
    const [context] = await claimAttempts(store.database, 1)
    assert.ok(context)
    await markRunning(store.database, context.attempt.id, 'system')
    return context
  }
  const finish = async (outcome: string) => {
    const context = await next()
    await completeAttempt(
      store.database,
      context.attempt.id,
      { outcome, summary: 'Stored verdict', artifacts: [] },
      { headCommit: head },
    )
  }
  return {
    root,
    home,
    store,
    repository,
    ticket,
    options,
    signal: new AbortController().signal,
    head,
    next,
    detail: async () => (await getTicketDetail(store.database, ticket.number))!,
    setPostChecks: (value: Checks) => {
      postChecks = value
    },
    /** Records passed verdicts and a ready publication, then parks the merge step. */
    async mergeWait() {
      await finish('passed')
      await finish('passed')
      await finish('ready')
      const merge = await next()
      await setPullRequestUrl(store.database, ticket.id, url)
      await waitForPullRequestMerge(
        store.database,
        merge.attempt.id,
        'pull-request-merge',
        head,
      )
      const [context] = await listWaitingForMerge(store.database)
      assert.ok(context)
      return context
    },
  }
}
