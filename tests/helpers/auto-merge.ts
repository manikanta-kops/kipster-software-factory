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
} from '../../src/store/tickets.ts'
import { runAttempt, type RunnerOptions } from '../../src/engine/runner.ts'
import type { Checks } from '../../src/github/checks.ts'
import type { PullRequest } from '../../src/github/github.ts'
import { createTestStore } from './store.ts'

export async function autoMergeFixture(
  t: TestContext,
  settings: {
    path?: string
    tester?: boolean
    settle?: number
    maxBaseSyncs?: number
  } = {},
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
  const workflow: Workflow = {
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
  const sourceWorkflow = JSON.stringify(workflow)
  const ticket = await createTicket(store.database, {
    repository: repository.slug,
    title: 'A useful change',
    workflow: {
      workflow,
      source: sourceWorkflow,
      version: workflowVersion(sourceWorkflow),
    },
  })
  const workspaces = new Workspaces(home)
  const signal = AbortSignal.timeout(30_000)
  const cwd = await workspaces.prepare(ticket, repository, signal)
  let head = await commit(
    cwd,
    settings.path ?? 'ui.ts',
    'export const label = "Last 10 minutes"\n',
  )
  let checks: Checks = { state: 'passed', failures: [] }
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
    enabledKey = true,
    confidence = 0.95,
    choice = 'merge',
    httpStatus = 200
  let onInspect: (() => Promise<void>) | undefined
  let onDecision: (() => Promise<void>) | undefined
  const sent: Record<string, unknown>[] = []
  const server = createServer(async (req, res) => {
    requests++
    let body = ''
    for await (const chunk of req) body += chunk
    sent.push(JSON.parse(body))
    await onDecision?.()
    res.writeHead(httpStatus, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify(
        httpStatus === 200
          ? {
              model: 'jev-1.13.0',
              answers: {
                decision: {
                  type: 'choice',
                  choice,
                  confidence,
                  probabilities:
                    choice === 'merge'
                      ? { merge: 0.98, owner: 0.02 }
                      : { merge: 0.02, owner: 0.98 },
                },
              },
              usage: { input_tokens: 100, output_tokens: 20 },
            }
          : { error: 'fixture failure' },
      ),
    )
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
      checks: async () => checks,
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
        summary: 'Agent prose sentinel; never a decision fact',
        artifacts: [],
      },
      { headCommit: head },
    )
  }
  if (settings.tester !== false) await pass()
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
    sent,
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
    setAnswer: (value: number, option = 'merge') => {
      confidence = value
      choice = option
    },
    noKey: () => {
      enabledKey = false
    },
    error: () => {
      httpStatus = 401
    },
    onDecision: (callback: () => Promise<void>) => {
      onDecision = callback
    },
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
