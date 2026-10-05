import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { engineConfig } from '../../src/config.ts'
import { runAttempt, type RunnerOptions } from '../../src/engine/runner.ts'
import type { AgentExecutor } from '../../src/executors/cli.ts'
import { run } from '../../src/executors/process.ts'
import { loadKit } from '../../src/kit/kit.ts'
import {
  createRepository,
  markRepositoryReady,
} from '../../src/store/repositories.ts'
import {
  claimAttempts,
  createTicket,
  decide,
  failAttempt,
  getTicketDetail,
  markRunning,
} from '../../src/store/tickets.ts'
import { Workspaces } from '../../src/workspace/workspaces.ts'
import { builtInWorkflow, createTestStore } from './store.ts'

export async function proofFixture(
  input: {
    dependency?: boolean
    workflow?: string
    script?: object
    fixed?: boolean
    execute?: AgentExecutor
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'factory-proof-'))
  const home = join(root, 'home')
  const source = join(root, 'source')
  await mkdir(join(source, '.kipster/verify/features'), { recursive: true })
  await mkdir(join(source, '.kipster/context'))
  await writeFile(
    join(source, '.kipster/context/index.md'),
    '- [Checkout](../verify/features/checkout.md): TRUSTED PROOF INDEX\n',
  )
  await copyFile(
    new URL('../fixtures/verification-app.ts', import.meta.url),
    join(source, 'app.ts'),
  )
  await writeFile(
    join(source, 'behaviour.txt'),
    input.fixed ? 'fixed' : 'broken',
  )
  await writeFile(
    join(source, '.kipster/kit.yml'),
    `version: 1\ncheck: echo checked\nverify:\n  start: ${process.execPath} app.ts {port} {databaseUrl}\n  ready: http://127.0.0.1:{port}/health\n  ports: 1\n  database: postgres\n  timeoutSeconds: 5\n`,
  )
  await writeFile(
    join(source, '.kipster/verify/README.md'),
    'This fixture is an HTTP API, the actual user surface. Drive POST /checkout with an empty JSON body using curl or fetch. Expect HTTP 200 and message Order placed. Save actual status and response output in evidenceDir. No authentication. Each instance starts fresh. Health readiness is not checkout proof. Do not read source to determine the response. No browser is needed for this API.',
  )
  await writeFile(
    join(source, '.kipster/verify/features/checkout.md'),
    '## Sub-features\nPlace order\n## How to get to it (user point of view)\nCall the public checkout API.\n## Driving it\n| User action | Exact command | Observable result |\n| --- | --- | --- |\n| Place order | curl -i -X POST -H "Content-Type: application/json" -d "{}" "$APP_URL/checkout" | HTTP 200, message Order placed |\n## Gotchas\nHealth readiness does not verify checkout.\n',
  )
  await run('git', ['init', '-b', 'main'], { cwd: source })
  const commit = async (cwd: string, message: string) => {
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
        message,
      ],
      { cwd },
    )
    return run('git', ['rev-parse', 'HEAD'], { cwd })
  }
  const base = await commit(source, 'Fixture')
  const bare = join(root, 'origin.git')
  await run('git', ['clone', '--bare', source, bare])
  const store = await createTestStore()
  const repository = await createRepository(store.database, {
    slug: 'fixture/proof',
    cloneUrl: bare,
  })
  const workspaces = new Workspaces(home)
  const preparationSignal = new AbortController().signal
  await workspaces.prepareRepository(repository, preparationSignal)
  await markRepositoryReady(store.database, repository.id, {
    kit: (await loadKit(source, base)).state,
  })
  if (input.dependency) {
    const dependencyRemote = join(root, 'reference.git')
    await run('git', ['clone', '--bare', source, dependencyRemote])
    const reference = await createRepository(store.database, {
      slug: 'fixture/reference',
      cloneUrl: dependencyRemote,
    })
    await markRepositoryReady(store.database, reference.id)
  }
  const ticket = await createTicket(store.database, {
    repository: repository.slug,
    ...(input.dependency ? { dependencies: ['fixture/reference'] } : {}),
    workflow: await builtInWorkflow(input.workflow ?? 'bug'),
    title: 'Checkout returns an error',
    body: 'POST /checkout with an empty JSON object returns HTTP 500 Checkout failed. Expected HTTP 200 Order placed. Prove the failure and fix.',
  })
  const cwd = await workspaces.prepare(ticket, repository, preparationSignal)
  const scriptFile = join(root, 'script.json')
  await writeFile(scriptFile, JSON.stringify(input.script ?? {}))
  const invocations: Parameters<AgentExecutor>[0][] = []
  const execute: AgentExecutor = async (invocation) => {
    invocations.push(invocation)
    if (input.execute) return input.execute(invocation)
    await run(
      process.execPath,
      [
        fileURLToPath(new URL('../fixtures/fake-agent.ts', import.meta.url)),
        invocation.directory,
        scriptFile,
        root,
      ],
      { cwd: invocation.cwd, log: invocation.log, signal: invocation.signal },
    )
  }
  const options: RunnerOptions = {
    database: store.database,
    home,
    config: engineConfig.parse({}),
    workspaces,
    execute,
    github: {
      merge: async () => {
        throw new Error('Unexpected merge')
      },
      commitChecks: async () => ({ state: 'none', failures: [] }),
      maintain: async () => {
        throw new Error('No publication in proof fixture')
      },
      inspect: async () => {
        throw new Error('No GitHub in proof fixture')
      },
      checks: async () => {
        throw new Error('No GitHub in proof fixture')
      },
      feedback: async () => {
        throw new Error('No GitHub in proof fixture')
      },
    },
  }
  const detail = async () =>
    (await getTicketDetail(store.database, ticket.number))!
  const next = async (step: string, signal = new AbortController().signal) => {
    const [context] = await claimAttempts(store.database, 1)
    assert.equal(context?.step.id, step)
    await markRunning(store.database, context.attempt.id, 'fixture')
    try {
      await runAttempt(options, context, signal)
    } catch (error) {
      if ((await detail()).ticket.status === 'running')
        await failAttempt(store.database, context.attempt.id, String(error))
      throw error
    }
    return (await detail()).attempts.find((a) => a.id === context.attempt.id)!
  }
  const approve = async () => {
    const d = await detail()
    await decide(store.database, {
      ticketNumber: ticket.number,
      attemptId: d.ticket.waiting!.attemptId,
      choice: 'approved',
    })
  }
  return {
    root,
    home,
    source,
    bare,
    base,
    store,
    ticket,
    cwd,
    options,
    invocations,
    next,
    approve,
    detail,
    commit,
    close: async (retain = false) => {
      await store.close()
      if (!retain) {
        if (input.dependency) await run('chmod', ['-R', 'u+w', root])
        await rm(root, { recursive: true, force: true })
      }
    },
  }
}
