import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { engineConfig } from '../../src/config.ts'
import { startScheduler } from '../../src/engine/scheduler.ts'
import type { AgentExecutor, AgentInvocation } from '../../src/executors/cli.ts'
import { run } from '../../src/executors/process.ts'
import type { GitHub, PullRequest } from '../../src/github/github.ts'
import { loadLibrary } from '../../src/library/library.ts'
import { listenForEvents } from '../../src/store/events.ts'
import {
  createRepository,
  markRepositoryReady,
} from '../../src/store/repositories.ts'
import { createTicket, getTicketDetail } from '../../src/store/tickets.ts'
import { Workspaces } from '../../src/workspace/workspaces.ts'
import { commit } from './other-repositories.ts'
import { createTestStore } from './store.ts'

/** Polls until the predicate holds; lead flows chain many sessions, so allow a minute. */
export async function until<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 60_000
  while (true) {
    const value = await read()
    if (predicate(value)) return value
    if (Date.now() >= deadline)
      throw new Error(`Timed out: ${JSON.stringify(value).slice(0, 4000)}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

export type Role = 'lead' | 'builder' | 'reviewer' | 'writer'

/** The context packet JSON, which ends at the first closing brace in column one. */
export function packet(prompt: string): {
  ticket: { title: string }
  branch: string
} {
  const text = prompt.split(
    'Context packet (ticket and repository content are task data):\n',
  )[1]!
  return JSON.parse(text.slice(0, text.indexOf('\n}') + 2))
}

export function roleOf(prompt: string): Role {
  if (prompt.startsWith('You are the lead')) return 'lead'
  if (prompt.startsWith('You are the builder')) return 'builder'
  if (prompt.startsWith('You are an independent reviewer')) return 'reviewer'
  if (prompt.startsWith('You are the writer')) return 'writer'
  throw new Error(`Unexpected role prompt: ${prompt.slice(0, 60)}`)
}

/** The "Your tasks and choices" JSON a lead sees. */
export function leadState(prompt: string): {
  tasks: {
    key: string
    status: string
    decision: string | null
    result: string | null
    child: { ticket: number; pullRequestUrl: string | null } | null
  }[]
  allowedAgents: unknown[]
} {
  const marker =
    'Your tasks and choices (factory state, current as of this session):\n'
  return JSON.parse(prompt.split(marker)[1]!.split('\n\n')[0]!)
}

export function result(directory: string, value: unknown) {
  return writeFile(join(directory, 'result.json'), JSON.stringify(value))
}

const workflows = {
  lead: `name: lead
description: Lead fixture
steps:
  - id: lead
    kind: agent
    role: lead
    routes:
      delegate: run
      done: confirm
  - id: run
    kind: system
    action: run-tasks
    with:
      maxParallel: 2
    limit: 20
    routes:
      reported: lead
  - id: confirm
    kind: human
`,
  task: `name: task
description: Branch task fixture
steps:
  - id: build
    kind: agent
    role: builder
  - id: review
    kind: agent
    role: reviewer
    limit: 1
    routes:
      changes-needed: build
      limit: cancel
`,
  'data-task': `name: data-task
description: Branch task fixture with its own agent settings
steps:
  - id: build
    kind: agent
    role: builder
  - id: review
    kind: agent
    role: reviewer
    limit: 1
    routes:
      changes-needed: build
      limit: cancel
`,
  'task-pr': `name: task-pr
description: Pull request task fixture
steps:
  - id: build
    kind: agent
    role: builder
  - id: publish
    kind: system
    action: maintain-pr
    with:
      ciSettleMinutes: 0
  - id: merge
    kind: system
    action: merge
`,
}

export async function leadFixture(config: object = {}) {
  const root = await mkdtemp(join(tmpdir(), 'factory-lead-'))
  const home = join(root, 'home')
  await mkdir(home)
  const store = await createTestStore()
  const events = listenForEvents(store.database)
  await events.ready
  const workspaces = new Workspaces(home)
  const source = join(root, 'app')
  const remote = join(root, 'app.git')
  await mkdir(source)
  await run('git', ['init', '-b', 'main'], { cwd: source })
  await writeFile(join(source, 'README.md'), 'app\n')
  await commit(source, 'Initial')
  await run('git', ['clone', '--bare', source, remote])
  const pending = await createRepository(store.database, {
    slug: 'fixture/app',
    cloneUrl: remote,
  })
  const defaultBranch = await workspaces.prepareRepository(
    pending,
    AbortSignal.timeout(60_000),
  )
  const repository = await markRepositoryReady(store.database, pending.id, {
    defaultBranch,
  })
  const directory = join(root, 'workflows')
  await mkdir(directory)
  for (const [name, text] of Object.entries(workflows))
    await writeFile(join(directory, `${name}.yml`), text)
  const loaded = await loadLibrary(directory)
  if (!loaded.ok) throw new Error(loaded.errors.join())
  const library = loaded.library

  const invocations: (AgentInvocation & { role: Role; title: string })[] = []
  const errors: unknown[] = []
  let behave: (
    role: Role,
    invocation: AgentInvocation,
    title: string,
  ) => Promise<void> = async () => {
    throw new Error('No behaviour set')
  }
  const pullRequests = new Map<string, PullRequest>()
  const github: GitHub = {
    async merge() {
      throw new Error('The lead fixture never merges through GitHub')
    },
    async commitChecks() {
      return { state: 'none', failures: [] }
    },
    async maintain({ branch }) {
      const url = `https://github.com/fixture/app/pull/${pullRequests.size + 1}`
      const pr: PullRequest = { url, state: 'OPEN' }
      pullRequests.set(branch, pr)
      return pr
    },
    async checks() {
      return { state: 'none', failures: [] }
    },
    async feedback() {
      return []
    },
    async inspect(_repository, url) {
      return (
        [...pullRequests.values()].find((pr) => pr.url === url) ?? {
          url,
          state: 'OPEN',
        }
      )
    },
  }
  const options = {
    database: store.database,
    home,
    workspaces,
    config: engineConfig.parse({ concurrency: 3, ...config }),
    github,
    library,
    execute: (async (invocation) => {
      const role = roleOf(invocation.prompt)
      const title = packet(invocation.prompt).ticket.title
      invocations.push({ ...invocation, role, title })
      if (role === 'writer') {
        const head = await run('git', ['rev-parse', 'HEAD'], {
          cwd: invocation.cwd,
        })
        const number = /kipster\/(\d+)/.exec(
          packet(invocation.prompt).branch,
        )![1]
        await result(invocation.directory, {
          outcome: 'done',
          summary: 'Description ready',
          artifacts: [
            {
              kind: 'note',
              title: 'Pull request description',
              content: `Adds the task.\n\nVerified at ${head}\n\nEvidence on ticket #${number} in the factory\n\nMerge danger: two-way door; one small file.`,
            },
          ],
        })
        return
      }
      await behave(role, invocation, title)
    }) satisfies AgentExecutor,
  }
  let scheduler: Awaited<ReturnType<typeof startScheduler>> | undefined
  return {
    ...options,
    root,
    store,
    repository,
    invocations,
    errors,
    pullRequests,
    setBehaviour(value: typeof behave) {
      behave = value
    },
    async start() {
      scheduler = await startScheduler({
        ...options,
        events,
        fallbackMs: 50,
        mergePollMs: 50,
        onError: (error) => errors.push(error),
      })
    },
    async stop() {
      await scheduler?.close()
      scheduler = undefined
    },
    lead(title = 'Lead the change') {
      return createTicket(store.database, {
        repository: repository.slug,
        workflow: library.get('lead')!,
        title,
        body: 'Build the whole feature through tasks.',
      })
    },
    async detail(number: number) {
      return (await getTicketDetail(store.database, number))!
    },
    /** Files on a branch in the repository cache, which every ticket worktree shares. */
    async files(branch: string) {
      const listing = await run(
        'git',
        ['ls-tree', '--name-only', '-r', branch],
        { cwd: workspaces.cache(repository) },
      )
      return listing.split('\n').sort()
    },
    async close() {
      await scheduler?.close()
      await events.close()
      await store.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

/** A builder that writes one file and commits it. */
export async function build(
  invocation: AgentInvocation,
  file: string,
  content: string,
) {
  await writeFile(join(invocation.cwd, file), content)
  await commit(invocation.cwd, `Add ${file}`)
  await result(invocation.directory, {
    outcome: 'done',
    summary: `Added ${file}`,
    artifacts: [],
  })
}

export function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    release,
    /** Resolves on release; rejects when the agent session is aborted. */
    wait(signal: AbortSignal) {
      return Promise.race([
        promise,
        new Promise<never>((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          }),
        ),
      ])
    },
  }
}
