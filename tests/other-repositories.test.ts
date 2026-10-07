import type { TicketResponse } from '../src/api/contract.ts'
import assert from 'node:assert/strict'
import { chmod, lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { test } from 'node:test'
import { run } from '../src/executors/process.ts'
import {
  addAttemptArtifacts,
  cancelTicket,
  claimAttempts,
  completeAttempt,
  decide,
  linkOtherRepository,
  listTickets,
  markRunning,
  resolveAsk,
  setPullRequestUrl,
} from '../src/store/tickets.ts'
import {
  commit,
  dependencies,
  otherRepositoriesFixture,
  packet,
  until,
} from './helpers/other-repositories.ts'
import { prepareDependencies } from '../src/workspace/dependencies.ts'

const request = {
  outcome: 'needs-other-repo',
  summary: 'The library API is needed first',
  artifacts: [],
  otherRepository: {
    repository: 'fixture/library',
    title: 'Expose the caller API',
    body: 'Add the API so the caller can implement the requested change.',
  },
}
function result(directory: string, value: unknown) {
  return writeFile(join(directory, 'result.json'), JSON.stringify(value))
}
function done(directory: string, planner = false) {
  return result(directory, {
    outcome: 'done',
    summary: 'Fixture completed',
    artifacts: planner
      ? [
          {
            kind: 'plan',
            title: 'Plan',
            content: 'Implement the API and prove it.',
          },
        ]
      : [],
  })
}

test('needs-other-repo creates one link across restart, releases its slot, and resumes a fresh builder with merged PR context', async (t) => {
  const f = await otherRepositoriesFixture()
  t.after(() => f.close())
  let originalRuns = 0
  f.setExecute(async (invocation) => {
    if (
      packet(invocation.prompt).ticket.title === 'Original' &&
      originalRuns++ === 0
    )
      await result(invocation.directory, request)
    else
      await done(
        invocation.directory,
        invocation.prompt.startsWith('You are the planner'),
      )
  })
  const original = await f.ticket()
  await f.start()
  const parked = await until(
    () => f.detail(original.number),
    (detail) => detail.ticket.waiting?.for === 'other-repo',
  )
  assert.equal(parked.ticket.status, 'running')
  assert.equal(parked.links.length, 1)
  const link = parked.links[0]!
  assert.deepEqual(link.request, {
    ...request.otherRepository,
    workflow: 'lead',
  })
  const linked = await until(
    () => f.detail(link.linked.number),
    (detail) => detail.ticket.waiting?.for === 'human',
  )
  assert.equal(linked.ticket.currentStep, 'approve-plan')
  assert.deepEqual(
    linked.dependencies.map((repo) => repo.slug),
    ['fixture/caller'],
  )
  assert.equal(linked.links[0]?.original.number, original.number)
  assert.ok(
    f.invocations.find((invocation) =>
      dependencies(invocation.prompt).some(
        (repo) => repo.repository === 'fixture/caller',
      ),
    ),
  )
  const sibling = await f.ticket('Unrelated work proves capacity')
  await until(
    () => f.detail(sibling.number),
    (detail) => detail.ticket.currentStep === 'confirm-completion',
  )
  await f.stop()
  await linkOtherRepository(
    f.database,
    link.attemptId,
    request,
    f.library.get('lead')!,
    parked.attempts[0]!.headCommit!,
  )
  await f.start()
  assert.equal((await f.detail(original.number)).links.length, 1)
  assert.equal(
    (await listTickets(f.database)).filter(
      (ticket) => ticket.repository.slug === 'fixture/library',
    ).length,
    1,
  )
  await decide(f.database, {
    ticketNumber: linked.ticket.number,
    attemptId: linked.ticket.waiting!.attemptId,
    choice: 'approved',
  })
  const publish = await until(
    () => f.detail(linked.ticket.number),
    (detail) => detail.ticket.currentStep === 'publish',
  )
  const url = 'https://github.com/fixture/library/pull/42'
  await setPullRequestUrl(f.database, publish.ticket.id, url)
  await decide(f.database, {
    ticketNumber: linked.ticket.number,
    attemptId: publish.ticket.waiting!.attemptId,
    choice: 'approved',
  })
  const resumed = await until(
    () => f.detail(original.number),
    (detail) => detail.ticket.currentStep === 'confirm-completion',
  )
  assert.equal(
    resumed.attempts.filter((attempt) => attempt.stepId === 'build').length,
    2,
  )
  const invocation = f.invocations.findLast(
    (item) => packet(item.prompt).ticket.title === 'Original',
  )!
  assert.match(
    invocation.prompt,
    /https:\/\/github.com\/fixture\/library\/pull\/42/,
  )
  assert.ok(invocation.prompt.includes('a'.repeat(40)))
  assert.ok(invocation.prompt.includes(request.summary))
  assert.ok(invocation.prompt.includes(request.otherRepository.title))
  assert.ok(invocation.prompt.includes(request.otherRepository.body))
  assert.equal(
    resumed.attempts.find((attempt) => attempt.id === link.attemptId)!.summary,
    request.summary,
  )
  assert.notEqual(invocation.directory, f.invocations[0]!.directory)
  assert.equal(resumed.links[0]?.mergeCommit, 'a'.repeat(40))
  assert.deepEqual(f.errors, [])
})

test('cancelled linked ticket asks the owner; cancelling an original leaves its linked ticket running', async (t) => {
  const f = await otherRepositoriesFixture()
  t.after(() => f.close())
  f.setExecute(async (invocation) => {
    if (packet(invocation.prompt).ticket.title.startsWith('Original'))
      await result(invocation.directory, request)
    else await done(invocation.directory, true)
  })
  await f.start()
  const original = await f.ticket()
  const parked = await until(
    () => f.detail(original.number),
    (detail) => detail.links.length === 1,
  )
  await cancelTicket(f.database, {
    ticketNumber: parked.links[0]!.linked.number,
  })
  const ask = await until(
    () => f.detail(original.number),
    (detail) => detail.ticket.waiting?.for === 'ask',
  )
  assert.match(ask.ticket.waiting!.summary!, /was cancelled/)
  assert.equal(
    ask.attempts.find((attempt) => attempt.id === parked.links[0]!.attemptId)!
      .summary,
    request.summary,
  )
  const second = await f.ticket('Original cancelled independently')
  const secondPark = await until(
    () => f.detail(second.number),
    (detail) => detail.links.length === 1,
  )
  await cancelTicket(f.database, { ticketNumber: second.number })
  await f.stop()
  await f.start()
  assert.equal((await f.detail(second.number)).ticket.status, 'cancelled')
  assert.notEqual(
    (await f.detail(secondPark.links[0]!.linked.number)).ticket.status,
    'cancelled',
  )
})

test('invalid other repository targets always ask the owner without a linked ticket, even when needs-decision has a custom workflow route', async (t) => {
  const f = await otherRepositoriesFixture()
  t.after(() => f.close())
  const { parseWorkflow } = await import('../src/domain/workflow.ts')
  const { workflowVersion } = await import('../src/library/library.ts')
  const { createTicket } = await import('../src/store/tickets.ts')
  const source = f.library
    .get('caller')!
    .source.replace(
      '    role: builder',
      '    role: builder\n    routes:\n      needs-decision: confirm-completion',
    )
  const parsed = parseWorkflow(source)
  if (!parsed.ok) assert.fail(parsed.errors.join())
  const variants: Record<string, [object, RegExp]> = {
    unregistered: [
      { repository: 'fixture/missing' },
      /No repository fixture\/missing/,
    ],
    workflow: [{ workflow: 'unknown' }, /No workflow/],
    'same-repository': [{ repository: 'fixture/caller' }, /another repository/],
  }
  f.setExecute(async (invocation) =>
    result(invocation.directory, {
      ...request,
      otherRepository: {
        ...request.otherRepository,
        ...variants[packet(invocation.prompt).ticket.title]![0],
      },
    }),
  )
  const tickets = new Map<string, number>()
  for (const title of Object.keys(variants)) {
    const ticket = await createTicket(f.database, {
      repository: 'fixture/caller',
      title,
      workflow: {
        workflow: parsed.workflow,
        version: workflowVersion(source),
        source,
      },
    })
    tickets.set(title, ticket.number)
  }
  await f.start()
  for (const [title, [, message]] of Object.entries(variants)) {
    const ask = await until(
      () => f.detail(tickets.get(title)!),
      (detail) => detail.ticket.status === 'needs-you',
    )
    assert.equal(ask.ticket.currentStep, 'build', title)
    assert.equal(ask.ticket.waiting?.for, 'ask', title)
    assert.equal(ask.links.length, 0, title)
    assert.match(ask.ticket.waiting!.summary!, message)
  }
  assert.equal((await listTickets(f.database)).length, 3)
})

test('dependency checkouts are fresh, detached, read-only and named with exact commits in every prompt', async (t) => {
  const f = await otherRepositoriesFixture()
  t.after(() => f.close())
  let observed = ''
  f.setExecute(async (invocation) => {
    const [dependency] = dependencies(invocation.prompt)
    assert.ok(dependency)
    assert.equal(
      await run('git', ['rev-parse', 'HEAD'], { cwd: dependency.path }),
      dependency.commit,
    )
    assert.equal(
      await run('git', ['branch', '--show-current'], { cwd: dependency.path }),
      '',
    )
    assert.equal(await run('git', ['remote'], { cwd: dependency.path }), '')
    assert.equal(
      (await lstat(join(dependency.path, 'README.md'))).mode & 0o222,
      0,
    )
    await assert.rejects(
      writeFile(join(dependency.path, 'README.md'), 'Forbidden'),
      /EACCES|EPERM/,
    )
    observed = await readFile(join(dependency.path, 'README.md'), 'utf8')
    await result(invocation.directory, {
      outcome: 'needs-decision',
      summary: 'Confirm the dependency context',
      artifacts: [],
    })
  })
  await writeFile(join(f.sources[1]!, 'README.md'), 'updated dependency\n')
  const firstCommit = await commit(f.sources[1]!, 'Advance dependency')
  await run('git', ['push', 'origin', 'next'], { cwd: f.sources[1]! })
  const ticket = await f.ticket('Dependency context', [f.repositories[1]!.slug])
  await f.start()
  const first = await until(
    () => f.detail(ticket.number),
    (detail) => detail.ticket.waiting?.for === 'ask',
  )
  assert.equal(
    observed,
    'updated dependency\n',
    first.ticket.waiting?.summary ?? 'Dependency context was not observed',
  )
  assert.ok(f.invocations[0]!.prompt.includes(firstCommit))
  const path = dependencies(f.invocations[0]!.prompt)[0]!.path
  await writeFile(join(f.sources[1]!, 'README.md'), 'second update\n')
  const secondCommit = await commit(f.sources[1]!, 'Advance again')
  await run('git', ['push', 'origin', 'next'], { cwd: f.sources[1]! })
  await resolveAsk(f.database, {
    ticketNumber: ticket.number,
    attemptId: first.ticket.waiting!.attemptId,
    resolution: { action: 'retry' },
  })
  await until(
    () => f.detail(ticket.number),
    (detail) =>
      detail.ticket.waiting?.for === 'ask' &&
      detail.ticket.waiting.attemptId !== first.ticket.waiting!.attemptId,
  )
  assert.equal(observed, 'second update\n')
  assert.equal(dependencies(f.invocations[1]!.prompt)[0]!.path, path)
  assert.ok(f.invocations[1]!.prompt.includes(secondCommit))
  assert.deepEqual(f.errors, [])
})

test('dependencies share cache objects, expose only the default branch, and survive force-push and cache GC', async (t) => {
  const f = await otherRepositoriesFixture()
  t.after(() => f.close())
  const repository = f.repositories[1]!
  const source = f.sources[1]!
  await run('git', ['checkout', '-b', 'kipster/unrelated'], { cwd: source })
  await writeFile(join(source, 'large-ticket-only.bin'), randomBytes(2_000_000))
  await commit(source, 'Unrelated ticket objects')
  await run('git', ['tag', 'unrelated-tag'], { cwd: source })
  await run('git', ['push', 'origin', 'kipster/unrelated', '--tags'], {
    cwd: source,
  })
  const ticket = await f.ticket('Object sharing', [repository.slug])
  const session = await prepareDependencies(
    f.workspaces,
    ticket,
    [repository],
    new AbortController().signal,
  )
  const checkout = session.checkouts[0]!
  const git = (args: string[]) => run('git', args, { cwd: checkout.path })
  assert.equal(
    await git(['for-each-ref', '--format=%(refname)']),
    'refs/heads/next',
  )
  assert.equal(await git(['remote']), '')
  assert.equal(
    await readFile(join(checkout.path, '.git/objects/info/alternates'), 'utf8'),
    `${join(f.workspaces.cache(repository), '.git/objects')}\n`,
  )
  assert.match(
    await git(['count-objects', '-v']),
    /^count: 0\nsize: 0\nin-pack: 0\npacks: 0\nsize-pack: 0\n/,
  )
  const bytes = async (path: string): Promise<number> => {
    const info = await lstat(path)
    return info.isDirectory()
      ? (
          await Promise.all(
            (await readdir(path)).map((name) => bytes(join(path, name))),
          )
        ).reduce((sum, value) => sum + value, 0)
      : info.size
  }
  assert.ok((await bytes(join(checkout.path, '.git'))) < 64_000)

  await run('git', ['checkout', '--orphan', 'replacement'], { cwd: source })
  await run('git', ['rm', '-rf', '.'], { cwd: source })
  await writeFile(join(source, 'README.md'), 'Replaced default branch\n')
  const replacement = await commit(source, 'Force-pushed history')
  await run('git', ['push', '--force', 'origin', 'HEAD:next'], { cwd: source })
  await f.workspaces.prepareRepository(repository, new AbortController().signal)
  const cacheGit = (args: string[]) =>
    run('git', args, { cwd: f.workspaces.cache(repository) })
  await cacheGit(['checkout', '--detach', replacement])
  for (const ref of [
    'refs/heads/next',
    'refs/remotes/origin/kipster/unrelated',
    'refs/tags/unrelated-tag',
  ])
    await cacheGit(['update-ref', '-d', ref])
  await cacheGit(['reflog', 'expire', '--expire=now', '--all'])
  await cacheGit(['gc', '--prune=now'])
  assert.equal(
    await cacheGit(['rev-parse', `refs/kipster/dependencies/${ticket.id}`]),
    checkout.commit,
  )
  assert.equal(await git(['show', 'HEAD:README.md']), 'library initial')
  await session.verify()
})

test('cleanup removes read-only dependencies and cache pins even when the ticket worktree is retained', async (t) => {
  const f = await otherRepositoriesFixture()
  t.after(() => f.close())
  const ticket = await f.ticket('Cleanup dependencies', ['fixture/library'])
  const signal = new AbortController().signal
  await f.workspaces.prepareRepository(f.repositories[0]!, signal)
  const path = await f.workspaces.prepare(ticket, f.repositories[0]!, signal)
  await writeFile(join(path, 'README.md'), 'Retain this ticket change')
  const session = await prepareDependencies(
    f.workspaces,
    ticket,
    [f.repositories[1]!],
    signal,
  )
  await session.verify()
  const root = join(f.home, 'dependencies', String(ticket.id))
  assert.equal((await lstat(session.checkouts[0]!.path)).mode & 0o222, 0)
  assert.equal(
    await f.workspaces.cleanup(
      { ...ticket, status: 'done' },
      f.repositories[0]!,
      signal,
    ),
    false,
  )
  await assert.rejects(lstat(root), { code: 'ENOENT' })
  assert.equal(
    await readFile(join(path, 'README.md'), 'utf8'),
    'Retain this ticket change',
  )
  assert.equal(
    await run(
      'git',
      ['for-each-ref', '--format=%(refname)', 'refs/kipster/dependencies'],
      { cwd: f.workspaces.cache(f.repositories[1]!) },
    ),
    '',
  )
})

test('scheduler removes read-only dependency checkouts when a ticket is done or cancelled', async (t) => {
  const f = await otherRepositoriesFixture()
  t.after(() => f.close())
  const terminals = [
    [await f.ticket('Done cleanup', ['fixture/library']), 'done'],
    [await f.ticket('Cancelled cleanup', ['fixture/library']), 'cancelled'],
  ] as const
  await f.start()
  for (const [ticket, terminal] of terminals) {
    const ready = await until(
      () => f.detail(ticket.number),
      (detail) => detail.ticket.waiting?.for === 'human',
    )
    const root = join(f.home, 'dependencies', String(ticket.id))
    assert.equal(
      (await lstat(join(root, String(f.repositories[1]!.id), 'repo'))).mode &
        0o222,
      0,
    )
    if (terminal === 'done')
      await decide(f.database, {
        ticketNumber: ticket.number,
        attemptId: ready.ticket.waiting!.attemptId,
        choice: 'approved',
      })
    else await cancelTicket(f.database, { ticketNumber: ticket.number })
  }
  for (const [ticket, terminal] of terminals) {
    await until(
      () =>
        lstat(join(f.home, 'dependencies', String(ticket.id))).catch(
          () => null,
        ),
      (info) => info === null,
    )
    await until(
      () => lstat(f.workspaces.path(ticket)).catch(() => null),
      (info) => info === null,
    )
    assert.equal((await f.detail(ticket.number)).ticket.status, terminal)
  }
  assert.equal(
    await run(
      'git',
      ['for-each-ref', '--format=%(refname)', 'refs/kipster/dependencies'],
      { cwd: f.workspaces.cache(f.repositories[1]!) },
    ),
    '',
  )
  assert.deepEqual(f.errors, [])
})

test('dependency restoration uses the step cancellation signal', async (t) => {
  const f = await otherRepositoriesFixture()
  t.after(() => f.close())
  const ticket = await f.ticket('Cancelled restoration', ['fixture/library'])
  const controller = new AbortController()
  const session = await prepareDependencies(
    f.workspaces,
    ticket,
    [f.repositories[1]!],
    controller.signal,
  )
  const path = session.checkouts[0]!.path
  await chmod(join(path, 'README.md'), 0o644)
  await writeFile(join(path, 'README.md'), 'Agent changed the dependency')
  controller.abort(new Error('Step restoration was cancelled'))
  await assert.rejects(
    session.verify(),
    /restoration failed.*Step restoration was cancelled.*README.md/,
  )
  assert.equal(
    await readFile(join(path, 'README.md'), 'utf8'),
    'Agent changed the dependency',
  )
  const restored = await prepareDependencies(
    f.workspaces,
    ticket,
    [f.repositories[1]!],
    new AbortController().signal,
  )
  await restored.verify()
  assert.equal(
    await readFile(join(path, 'README.md'), 'utf8'),
    'library initial\n',
  )
})

test('linked-ticket polling is throttled despite frequent scheduler wakes', async (t) => {
  const f = await otherRepositoriesFixture({ git: false })
  t.after(() => f.close())
  const original = await f.ticket()
  const context = (await claimAttempts(f.database, 1))[0]!
  await markRunning(f.database, context.attempt.id, 'codex')
  const link = await linkOtherRepository(
    f.database,
    context.attempt.id,
    request,
    f.library.get('lead')!,
    'b'.repeat(40),
  )
  const linkedPlan = (await claimAttempts(f.database, 1))[0]!
  await markRunning(f.database, linkedPlan.attempt.id, 'codex')
  await completeAttempt(f.database, linkedPlan.attempt.id, {
    outcome: 'done',
    summary: 'Plan',
    artifacts: [],
  })
  let detail = await f.detail(link.linked.number)
  await decide(f.database, {
    ticketNumber: detail.ticket.number,
    attemptId: detail.ticket.waiting!.attemptId,
    choice: 'approved',
  })
  const linkedBuild = (await claimAttempts(f.database, 1))[0]!
  await markRunning(f.database, linkedBuild.attempt.id, 'codex')
  await completeAttempt(f.database, linkedBuild.attempt.id, {
    outcome: 'done',
    summary: 'Built',
    artifacts: [],
  })
  detail = await f.detail(link.linked.number)
  await setPullRequestUrl(
    f.database,
    detail.ticket.id,
    'https://github.com/fixture/library/pull/42',
  )
  await decide(f.database, {
    ticketNumber: detail.ticket.number,
    attemptId: detail.ticket.waiting!.attemptId,
    choice: 'approved',
  })
  const merge = (await claimAttempts(f.database, 1))[0]!
  await markRunning(f.database, merge.attempt.id, 'system')
  await completeAttempt(f.database, merge.attempt.id, {
    outcome: 'merged',
    summary: 'Merged',
    artifacts: [],
  })
  let polls = 0
  f.github.inspect = async () => {
    polls++
    throw new Error('Temporary GitHub error keeps the link unresolved')
  }
  await f.start({ mergePollMs: 60_000, fallbackMs: 20 })
  await until(
    async () => polls,
    (count) => count === 1,
  )
  // Frozen Date makes the 60 s interval exact; scheduler timers stay real.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  for (let wake = 0; wake < 4; wake++)
    await addAttemptArtifacts(f.database, context.attempt.id, [
      {
        kind: 'note',
        title: `Wake ${wake}`,
        content: 'Poll interval should still apply.',
      },
    ])
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(polls, 1)
  t.mock.timers.tick(60_000)
  await until(
    async () => polls,
    (count) => count === 2,
  )
  assert.equal(
    (await f.detail(original.number)).ticket.waiting?.for,
    'other-repo',
  )
  t.mock.timers.reset()
})

test('tracked, ignored and metadata dependency changes from a failing executor go to the owner and restore the checkout', async (t) => {
  const f = await otherRepositoriesFixture()
  t.after(() => f.close())
  let dependencyPath = ''
  f.setExecute(async (invocation) => {
    const [dependency] = dependencies(invocation.prompt)
    dependencyPath = dependency!.path
    await chmod(dependencyPath, 0o755)
    await writeFile(
      join(dependencyPath, 'ignored.txt'),
      'forbidden ignored content',
    )
    for (const file of ['README.md', '.git/config']) {
      await chmod(join(dependencyPath, file), 0o644)
      await writeFile(join(dependencyPath, file), 'forbidden change')
    }
    throw new Error('Agent crashed after editing')
  })
  const ticket = await f.ticket('Dependency edit', [f.repositories[1]!.slug])
  await f.start()
  const ask = await until(
    () => f.detail(ticket.number),
    (detail) => detail.ticket.waiting?.for === 'ask',
  )
  for (const change of [
    /changed read-only dependencies; restored/,
    /README\.md/,
    /ignored\.txt/,
    /\.git\/config/,
  ])
    assert.match(ask.ticket.waiting!.summary!, change)
  assert.equal(
    await readFile(join(dependencyPath, 'README.md'), 'utf8'),
    'library initial\n',
  )
  assert.equal(
    await run('git', ['status', '--porcelain', '--ignored'], {
      cwd: dependencyPath,
    }),
    '',
  )
  assert.equal(await run('git', ['remote'], { cwd: dependencyPath }), '')
  assert.equal((await lstat(join(dependencyPath, 'README.md'))).mode & 0o222, 0)
  assert.equal((await lstat(dependencyPath)).mode & 0o222, 0)
  assert.equal(
    await run('git', ['show', 'next:README.md'], { cwd: f.remotes[1]! }),
    'library initial',
  )
})

test('the creation API validates and deduplicates optional dependency repositories', async (t) => {
  const f = await otherRepositoriesFixture({ git: false })
  t.after(() => f.close())
  const { createApp } = await import('../src/api/app.ts')
  const app = createApp({
    database: f.database,
    library: f.library,
    events: f.events,
    home: f.home,
  })
  const create = (deps: unknown) =>
    app.request('/api/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repository: 'fixture/caller',
        workflow: 'caller',
        title: 'API dependencies',
        dependencies: deps,
      }),
    })
  for (const deps of [
    ['fixture/missing'],
    ['fixture/caller'],
    ['invalid'],
    'fixture/library',
  ]) {
    const response = await create(deps)
    assert.equal(response.status, 400)
  }
  const response = await create(['fixture/library', 'FIXTURE/LIBRARY'])
  assert.equal(response.status, 201)
  const detail = (await response.json()) as TicketResponse
  assert.deepEqual(
    detail.dependencies?.map((repo: { slug: string }) => repo.slug),
    ['fixture/library'],
  )
  assert.deepEqual(detail.links, [])
  assert.equal((await listTickets(f.database)).length, 1)
})

test('cached dependencies discard stale edits after a factory restart and preserve unowned paths', async (t) => {
  const f = await otherRepositoriesFixture()
  t.after(() => f.close())
  const ticket = await f.ticket('Cache recovery', ['fixture/library'])
  const session = await prepareDependencies(
    f.workspaces,
    ticket,
    [f.repositories[1]!],
    AbortSignal.timeout(30_000),
  )
  const path = session.checkouts[0]!.path
  await chmod(join(path, 'README.md'), 0o644)
  await writeFile(
    join(path, 'README.md'),
    'Left behind by an interrupted factory',
  )
  const { Workspaces } = await import('../src/workspace/workspaces.ts')
  const recovered = await prepareDependencies(
    new Workspaces(f.home),
    ticket,
    [f.repositories[1]!],
    AbortSignal.timeout(30_000),
  )
  assert.equal(
    await readFile(join(path, 'README.md'), 'utf8'),
    'library initial\n',
  )
  await recovered.verify()
  const { rm } = await import('node:fs/promises')
  await rm(join(path, '..', 'owner.json'))
  await assert.rejects(
    prepareDependencies(
      f.workspaces,
      ticket,
      [f.repositories[1]!],
      AbortSignal.timeout(30_000),
    ),
    /unowned dependency checkout/,
  )
  assert.equal(
    await readFile(join(path, 'README.md'), 'utf8'),
    'library initial\n',
  )
})

test('PR writer fails and restores dependency edits without a retry, then receives fresh dependency context', async (t) => {
  const f = await otherRepositoriesFixture()
  t.after(() => f.close())
  const { writePullRequest } = await import('../src/engine/pr-writer.ts')
  const ticket = await f.ticket('Writer context', ['fixture/library'])
  const [context] = await claimAttempts(f.database, 1)
  await markRunning(f.database, context!.attempt.id, 'system')
  const signal = AbortSignal.timeout(30_000)
  await f.workspaces.prepareRepository(f.repositories[0]!, signal)
  const cwd = await f.workspaces.prepare(ticket, f.repositories[0]!, signal)
  const head = await run('git', ['rev-parse', 'HEAD'], { cwd })
  let path = ''
  let modify = true
  f.setExecute(async (invocation) => {
    const [dependency] = dependencies(invocation.prompt)
    path = dependency!.path
    assert.equal(
      await run('git', ['rev-parse', 'HEAD'], { cwd: path }),
      dependency!.commit,
    )
    if (modify) {
      await chmod(join(path, 'README.md'), 0o644)
      await writeFile(
        join(path, 'README.md'),
        'Writer must not edit dependencies',
      )
    }
    await result(invocation.directory, {
      outcome: 'done',
      summary: 'Prose ready',
      artifacts: [
        {
          kind: 'note',
          title: 'Description',
          content: `Fixture description. Verified at ${head}\nEvidence on ticket #${ticket.number} in the factory\nMerge danger: two-way door; prose only.`,
        },
      ],
    })
  })
  await assert.rejects(
    writePullRequest(f, context!, cwd, head, signal),
    /changed read-only dependencies; restored/,
  )
  assert.equal(f.invocations.length, 1)
  assert.equal(
    await readFile(join(path, 'README.md'), 'utf8'),
    'library initial\n',
  )
  modify = false
  assert.match(
    await writePullRequest(f, context!, cwd, head, signal),
    /Fixture description/,
  )
  assert.equal(f.invocations.length, 2)
  assert.equal(
    await readFile(join(path, 'README.md'), 'utf8'),
    'library initial\n',
  )
})

test('independent reproducer receives fresh dependency context', async (t) => {
  const { proofFixture } = await import('./helpers/proof.ts')
  let path = ''
  const f = await proofFixture({
    dependency: true,
    execute: async (invocation) => {
      const [dependency] = dependencies(invocation.prompt)
      path = dependency!.path
      assert.notEqual(path, invocation.cwd)
      assert.equal(
        await run('git', ['rev-parse', 'HEAD'], { cwd: path }),
        dependency!.commit,
      )
      await result(invocation.directory, {
        outcome: 'needs-decision',
        summary: 'Owner decision on the reproduction',
        artifacts: [],
      })
    },
  })
  t.after(() => f.close())
  await f.next('reproduce')
  assert.equal((await f.detail()).ticket.waiting?.for, 'ask')
  assert.equal(await readFile(join(path, 'behaviour.txt'), 'utf8'), 'broken')
})

test('an instance crash during reproduction still fails, restores dependencies and reports their changed files to the owner', async (t) => {
  const { proofFixture } = await import('./helpers/proof.ts')
  const { proofContext } = await import('./fixtures/proof-agent.ts')
  let path = ''
  const f = await proofFixture({
    dependency: true,
    execute: async (invocation) => {
      const [dependency] = dependencies(invocation.prompt)
      path = dependency!.path
      assert.notEqual(path, invocation.cwd)
      assert.equal(
        await run('git', ['rev-parse', 'HEAD'], { cwd: path }),
        dependency!.commit,
      )
      await chmod(join(path, 'behaviour.txt'), 0o644)
      await writeFile(
        join(path, 'behaviour.txt'),
        'Modified before instance crash',
      )
      const instance = proofContext(invocation.prompt).instances[0]!
      const { pid } = (await (
        await fetch(`${instance.url}/health`)
      ).json()) as { pid: number }
      process.kill(pid, 'SIGTERM')
      await new Promise<void>((_resolve, reject) => {
        if (invocation.signal.aborted) reject(invocation.signal.reason)
        else
          invocation.signal.addEventListener(
            'abort',
            () => reject(invocation.signal.reason),
            { once: true },
          )
      })
    },
  })
  t.after(() => f.close())
  await assert.rejects(
    f.next('reproduce'),
    /changed read-only dependencies; restored/,
  )
  const detail = await f.detail()
  assert.match(detail.ticket.waiting!.summary!, /behaviour.txt/)
  assert.equal(await readFile(join(path, 'behaviour.txt'), 'utf8'), 'broken')
  assert.deepEqual(await readdir(join(f.home, 'verification')), [])
})
