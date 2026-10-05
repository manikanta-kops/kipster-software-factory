import type { TicketResponse } from '../src/api/contract.ts'
import assert from 'node:assert/strict'
import { chmod, lstat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { run } from '../src/executors/process.ts'
import {
  cancelTicket,
  decide,
  linkOtherRepository,
  listTickets,
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
    f.library.get('feature')!,
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

for (const invalid of [
  'unregistered',
  'workflow',
  'same-repository',
  'malformed',
] as const) {
  test(`invalid other repository request (${invalid}) goes to the owner without a linked ticket`, async (t) => {
    const f = await otherRepositoriesFixture()
    t.after(() => f.close())
    f.setExecute(async (invocation) =>
      result(invocation.directory, {
        ...request,
        otherRepository:
          invalid === 'malformed'
            ? { repository: 'invalid' }
            : {
                ...request.otherRepository,
                ...(invalid === 'unregistered'
                  ? { repository: 'fixture/missing' }
                  : invalid === 'same-repository'
                    ? { repository: 'fixture/caller' }
                    : { workflow: 'unknown' }),
              },
      }),
    )
    const ticket = await f.ticket()
    await f.start()
    const ask = await until(
      () => f.detail(ticket.number),
      (detail) => detail.ticket.waiting?.for === 'ask',
    )
    assert.equal(ask.links.length, 0)
    assert.match(
      ask.ticket.waiting!.summary!,
      invalid === 'malformed'
        ? /Invalid or missing result/
        : invalid === 'unregistered'
          ? /No repository fixture\/missing/
          : invalid === 'same-repository'
            ? /another repository/
            : /No workflow/,
    )
    assert.equal((await listTickets(f.database)).length, 1)
  })
}

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

for (const edit of [
  'tracked',
  'ignored',
  'metadata',
  'executor-failure',
] as const) {
  test(`dependency ${edit} changes fail to the owner and restore the checkout`, async (t) => {
    const f = await otherRepositoriesFixture()
    t.after(() => f.close())
    let dependencyPath = ''
    f.setExecute(async (invocation) => {
      const [dependency] = dependencies(invocation.prompt)
      dependencyPath = dependency!.path
      if (edit === 'ignored') {
        await chmod(dependencyPath, 0o755)
        await writeFile(
          join(dependencyPath, 'ignored.txt'),
          'forbidden ignored content',
        )
      } else {
        const file = join(
          dependencyPath,
          edit === 'metadata' ? '.git/config' : 'README.md',
        )
        await chmod(file, 0o644)
        await writeFile(file, 'forbidden change')
      }
      if (edit === 'executor-failure')
        throw new Error('Agent crashed after editing')
      await done(invocation.directory)
    })
    const ticket = await f.ticket('Dependency edit', [f.repositories[1]!.slug])
    await f.start()
    const ask = await until(
      () => f.detail(ticket.number),
      (detail) => detail.ticket.waiting?.for === 'ask',
    )
    assert.match(
      ask.ticket.waiting!.summary!,
      /changed read-only dependencies; restored/,
    )
    assert.match(
      ask.ticket.waiting!.summary!,
      edit === 'ignored'
        ? /ignored.txt/
        : edit === 'metadata'
          ? /\.git\/config/
          : /README.md/,
    )
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
    assert.equal(
      (await lstat(join(dependencyPath, 'README.md'))).mode & 0o222,
      0,
    )
    assert.equal(
      await run('git', ['show', 'next:README.md'], { cwd: f.remotes[1]! }),
      'library initial',
    )
  })
}

test('the creation API validates and deduplicates optional dependency repositories', async (t) => {
  const f = await otherRepositoriesFixture()
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
  const { prepareDependencies } =
    await import('../src/workspace/dependencies.ts')
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

for (const modify of [false, true]) {
  test(`PR writer ${modify ? 'fails and restores dependency edits' : 'receives fresh dependency context'}`, async (t) => {
    const f = await otherRepositoriesFixture()
    t.after(() => f.close())
    const { writePullRequest } = await import('../src/engine/pr-writer.ts')
    const { claimAttempts, markRunning } =
      await import('../src/store/tickets.ts')
    const ticket = await f.ticket('Writer context', ['fixture/library'])
    const [context] = await claimAttempts(f.database, 1)
    await markRunning(f.database, context!.attempt.id, 'system')
    const cwd = await f.workspaces.prepare(
      ticket,
      f.repositories[0]!,
      AbortSignal.timeout(30_000),
    )
    const head = await run('git', ['rev-parse', 'HEAD'], { cwd })
    let path = ''
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
    const writing = writePullRequest(
      f,
      context!,
      cwd,
      head,
      AbortSignal.timeout(30_000),
    )
    if (modify)
      await assert.rejects(writing, /changed read-only dependencies; restored/)
    else assert.match(await writing, /Fixture description/)
    assert.equal(
      await readFile(join(path, 'README.md'), 'utf8'),
      'library initial\n',
    )
  })
}

for (const modify of [false, true]) {
  test(`independent reproducer ${modify ? 'fails and restores dependency edits' : 'receives fresh dependency context'}`, async (t) => {
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
        if (modify) {
          await chmod(join(path, 'behaviour.txt'), 0o644)
          await writeFile(
            join(path, 'behaviour.txt'),
            'Cannot change reference behavior',
          )
        }
        await result(invocation.directory, {
          outcome: 'needs-decision',
          summary: 'Owner decision on the reproduction',
          artifacts: [],
        })
      },
    })
    t.after(() => f.close())
    if (modify)
      await assert.rejects(
        f.next('reproduce'),
        /changed read-only dependencies; restored/,
      )
    else await f.next('reproduce')
    assert.equal((await f.detail()).ticket.waiting?.for, 'ask')
    assert.equal(await readFile(join(path, 'behaviour.txt'), 'utf8'), 'broken')
  })
}

test('invalid targets always ask the owner even when needs-decision has a custom workflow route', async (t) => {
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
  const ticket = await createTicket(f.database, {
    repository: 'fixture/caller',
    title: 'Invalid target with a route',
    workflow: {
      workflow: parsed.workflow,
      version: workflowVersion(source),
      source,
    },
  })
  f.setExecute(async (invocation) =>
    result(invocation.directory, {
      ...request,
      otherRepository: {
        ...request.otherRepository,
        repository: 'fixture/missing',
      },
    }),
  )
  await f.start()
  const ask = await until(
    () => f.detail(ticket.number),
    (detail) => detail.ticket.status === 'needs-you',
  )
  assert.equal(ask.ticket.currentStep, 'build')
  assert.equal(ask.ticket.waiting?.for, 'ask')
  assert.match(ask.ticket.waiting!.summary!, /No repository fixture\/missing/)
})

test('an instance crash still restores dependencies and reports their changed files to the owner', async (t) => {
  const { proofFixture } = await import('./helpers/proof.ts')
  const { proofContext } = await import('./fixtures/proof-agent.ts')
  let path = ''
  const f = await proofFixture({
    dependency: true,
    execute: async (invocation) => {
      path = dependencies(invocation.prompt)[0]!.path
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
  const { readdir } = await import('node:fs/promises')
  assert.deepEqual(await readdir(join(f.home, 'verification')), [])
})
