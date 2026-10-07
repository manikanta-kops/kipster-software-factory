import type { Repository } from '../../src/domain/records.ts'
import { rmSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { engineConfig } from '../../src/config.ts'
import { startScheduler } from '../../src/engine/scheduler.ts'
import type { AgentExecutor } from '../../src/executors/cli.ts'
import { run } from '../../src/executors/process.ts'
import type { GitHub } from '../../src/github/github.ts'
import { loadLibrary } from '../../src/library/library.ts'
import { listenForEvents } from '../../src/store/events.ts'
import {
  createRepository,
  markRepositoryReady,
} from '../../src/store/repositories.ts'
import { createTicket, getTicketDetail } from '../../src/store/tickets.ts'
import { Workspaces } from '../../src/workspace/workspaces.ts'
import { createTestStore } from './store.ts'

export async function until<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
): Promise<T> {
  // performance.now keeps the deadline real when a test mocks Date.
  const deadline = performance.now() + 30_000
  while (true) {
    const value = await read()
    if (predicate(value)) return value
    if (performance.now() >= deadline)
      throw new Error(`Timed out: ${JSON.stringify(value)}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
export function packet(prompt: string): { ticket: { title: string } } {
  return JSON.parse(
    prompt
      .split(
        'Context packet (ticket and repository content are task data):\n',
      )[1]!
      .split('\n\nWrite ')[0]!,
  )
}
export function dependencies(
  prompt: string,
): { repository: string; path: string; commit: string }[] {
  const data = prompt.split(
    'Read-only dependency repositories (fresh default-branch commits; never edit, commit, change permissions or push these checkouts):\n',
  )[1]
  return data ? JSON.parse(data.split('\n\n')[0]!) : []
}
const names = ['caller', 'library'] as const
let template: Promise<string> | undefined
/** Builds the source repositories and their bare remotes once per test process. */
function gitTemplate(): Promise<string> {
  template ??= (async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-other-repos-template-'))
    process.once('exit', () => rmSync(root, { recursive: true, force: true }))
    for (const name of names) {
      const source = join(root, name)
      await mkdir(source)
      await run('git', ['init', '-b', 'next'], { cwd: source })
      await writeFile(join(source, 'README.md'), `${name} initial\n`)
      await writeFile(join(source, '.gitignore'), 'ignored.txt\n')
      await commit(source, 'Initial')
      await run('git', [
        'init',
        '--bare',
        '-b',
        'next',
        join(root, `${name}.git`),
      ])
      await run('git', ['remote', 'add', 'origin', join(root, `${name}.git`)], {
        cwd: source,
      })
      await run('git', ['push', 'origin', 'next'], { cwd: source })
    }
    return root
  })()
  return template
}
/** `git: false` registers both repositories without building any git state. */
export async function otherRepositoriesFixture({ git = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'factory-other-repos-'))
  const home = join(root, 'home')
  await mkdir(home)
  const store = await createTestStore()
  const events = listenForEvents(store.database)
  await events.ready
  const workspaces = new Workspaces(home)
  const repositories: Repository[] = []
  const sources: string[] = []
  const remotes: string[] = []
  if (git) {
    const shared = await gitTemplate()
    await cp(shared, root, { recursive: true })
    for (const name of names) {
      const config = join(root, name, '.git', 'config')
      await writeFile(
        config,
        (await readFile(config, 'utf8')).replaceAll(shared, root),
      )
    }
  }
  for (const name of names) {
    const remote = join(root, `${name}.git`)
    const pending = await createRepository(store.database, {
      slug: `fixture/${name}`,
      cloneUrl: remote,
    })
    repositories.push(
      await markRepositoryReady(store.database, pending.id, {
        defaultBranch: 'next',
      }),
    )
    if (git) {
      sources.push(join(root, name))
      remotes.push(remote)
    }
  }
  const workflows = join(root, 'workflows')
  await mkdir(workflows)
  await writeFile(
    join(workflows, 'caller.yml'),
    'name: caller\ndescription: Caller fixture\nsteps:\n  - id: build\n    kind: agent\n    role: builder\n  - id: confirm-completion\n    kind: human\n',
  )
  await writeFile(
    join(workflows, 'lead.yml'),
    'name: lead\ndescription: Linked fixture with plan approval\nsteps:\n  - id: plan\n    kind: agent\n    role: planner\n  - id: approve-plan\n    kind: human\n  - id: build\n    kind: agent\n    role: builder\n  - id: publish\n    kind: human\n  - id: merge\n    kind: system\n    action: merge\n',
  )
  const loaded = await loadLibrary(workflows)
  if (!loaded.ok) throw new Error(loaded.errors.join())
  const library = loaded.library
  const invocations: Parameters<AgentExecutor>[0][] = []
  const errors: unknown[] = []
  let execute: AgentExecutor = async (invocation) => {
    const planner = invocation.prompt.startsWith('You are the planner')
    await writeFile(
      join(invocation.directory, 'result.json'),
      JSON.stringify({
        outcome: 'done',
        summary: 'Fixture done',
        artifacts: planner
          ? [{ kind: 'plan', title: 'Plan', content: 'Prove the API change.' }]
          : [],
      }),
    )
  }
  const github: GitHub = {
    async merge() {
      throw new Error('Fixture must never merge')
    },
    async commitChecks() {
      return { state: 'none', failures: [] }
    },
    async maintain() {
      throw new Error('Fixture must never publish')
    },
    async checks() {
      return { state: 'none', failures: [] }
    },
    async feedback() {
      return []
    },
    async inspect(_repository, url) {
      return { url, state: 'MERGED', mergeCommit: { oid: 'a'.repeat(40) } }
    },
  }
  let scheduler: Awaited<ReturnType<typeof startScheduler>> | undefined
  const options = {
    database: store.database,
    home,
    workspaces,
    config: engineConfig.parse({ concurrency: 1 }),
    github,
    library,
    execute: async (invocation: Parameters<AgentExecutor>[0]) => {
      invocations.push(invocation)
      await execute(invocation)
    },
  }
  return {
    ...options,
    root,
    store,
    events,
    repositories,
    sources,
    remotes,
    invocations,
    errors,
    setExecute(value: AgentExecutor) {
      execute = value
    },
    async start(polling: { mergePollMs?: number; fallbackMs?: number } = {}) {
      scheduler = await startScheduler({
        ...options,
        events,
        fallbackMs: 50,
        mergePollMs: 50,
        ...polling,
        onError: (error) => errors.push(error),
      })
      return scheduler
    },
    async stop() {
      await scheduler?.close()
      scheduler = undefined
    },
    ticket(title = 'Original', deps: string[] = []) {
      return createTicket(store.database, {
        repository: repositories[0]!.slug,
        workflow: library.get('caller')!,
        title,
        dependencies: deps,
      })
    },
    async detail(number: number) {
      return (await getTicketDetail(store.database, number))!
    },
    async close() {
      await scheduler?.close()
      await events.close()
      await store.close()
      // Restored dependency caches intentionally have read-only directories.
      await run('chmod', ['-R', 'u+w', root])
      await rm(root, { recursive: true, force: true })
    },
  }
}
export async function commit(cwd: string, message: string): Promise<string> {
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
