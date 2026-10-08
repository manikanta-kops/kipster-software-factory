import assert from 'node:assert/strict'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { withPreparedArtifacts } from '../src/store/artifact-preparation.ts'
import { setArtifactHome } from '../src/store/database.ts'
import { runAttempt } from '../src/engine/runner.ts'
import { pollTasks, leadContext } from '../src/engine/tasks.ts'
import { run } from '../src/executors/process.ts'
import { runsOf } from '../src/domain/lifecycle.ts'
import {
  createRepository,
  markRepositoryReady,
} from '../src/store/repositories.ts'
import {
  cancelTicket,
  claimAttempts,
  completeAttempt,
  completeParallelAttempts,
  createTicket,
  getTicketDetail,
  markRunning,
  startParallelReview,
} from '../src/store/tickets.ts'
import { builtInWorkflow, createTestStore } from './helpers/store.ts'
import { build, leadFixture, result } from './helpers/lead.ts'
import { proofContext } from './fixtures/proof-agent.ts'

async function finalFixture(t: TestContext) {
  const f = await leadFixture(
    {
      agents: {
        default: { cli: 'codex', model: 'build' },
        roles: {
          tester: { cli: 'claude', model: 'test' },
          reviewer: { cli: 'codex', model: 'review' },
        },
      },
    },
    'missing',
  )
  t.after(() => f.close())
  f.library.set('lead', await builtInWorkflow('lead'))
  const ticket = await f.lead()
  const signal = AbortSignal.timeout(60_000)
  const next = async () => {
    const [context] = await claimAttempts(f.database, 1)
    assert.ok(context)
    await markRunning(f.database, context.attempt.id, 'fixture')
    await runAttempt({ ...f, parallelFinal: true }, context, signal)
    return context
  }
  return { f, ticket, signal, next }
}

async function check(
  invocation: Parameters<typeof build>[0],
  outcome = 'passed',
) {
  const [instance] = proofContext(invocation.prompt).instances
  assert.ok(instance)
  const observed = await readFile(join(instance.checkout, 'README.md'), 'utf8')
  assert.equal(observed, 'app\n')
  const path = join(instance.evidenceDir, 'check.txt')
  await writeFile(path, observed)
  await result(invocation.directory, {
    outcome,
    summary: 'Checked fixture README',
    artifacts: [
      { kind: 'evidence', title: 'README check', path },
      ...(outcome === 'changes-needed'
        ? [
            {
              kind: 'finding',
              title: 'Fixture correction',
              content:
                'Scenario: README\nObserved: app text\nExpected: corrected text\nEvidence: check.txt',
            },
          ]
        : []),
    ],
  })
}

for (const survivor of ['tester', 'reviewer'] as const) {
  test(`paired final keeps ${survivor}'s changes-needed when its sibling crashes`, async (t) => {
    const { f, ticket, next } = await finalFixture(t)
    f.setBehaviour(async (role, invocation) => {
      if (role === 'lead')
        return result(invocation.directory, {
          outcome: 'done',
          summary: 'Final checks',
          artifacts: [],
        })
      if (role !== survivor) throw new Error(`${role} crashed`)
      if (role === 'tester') return check(invocation, 'changes-needed')
      return result(invocation.directory, {
        outcome: 'changes-needed',
        summary: 'Reviewer correction',
        artifacts: [
          {
            kind: 'finding',
            title: 'Correct README',
            content: 'README must change',
          },
        ],
      })
    })
    await next()
    await next()
    const detail = await f.detail(ticket.number)
    assert.equal(detail.ticket.currentStep, 'lead')
    assert.equal(detail.ticket.status, 'queued')
    const tested = detail.attempts.findLast((a) => a.stepId === 'final-test')!
    const reviewed = detail.attempts.findLast((a) => a.stepId === 'review')!
    const survived = survivor === 'tester' ? tested : reviewed
    const crashed = survivor === 'tester' ? reviewed : tested
    assert.equal(survived.status, 'finished')
    assert.equal(survived.outcome, 'changes-needed')
    assert.equal(crashed.status, 'failed')
    assert.equal(crashed.outcome, null)
    assert.match(crashed.error!, /crashed|Invalid or missing result\.json/)
    assert.equal(crashed.headCommit, survived.headCommit)
    assert.equal(
      detail.attempts.filter((a) => a.status === 'pending').length,
      1,
    )
    assert.ok(
      detail.artifacts.some(
        (a) => a.attemptId === survived.id && a.kind === 'finding',
      ),
    )
    assert.ok(
      detail.events.some(
        (e) =>
          e.kind === 'attempt.failed' && e.data['attemptId'] === crashed.id,
      ),
    )
  })
}

test('evidence sweep keeps newest 50 recursively, excludes declared files, and leaves a single count note', async (t) => {
  const { f, ticket, next } = await finalFixture(t)
  let evidenceDir = ''
  f.setBehaviour(async (role, invocation) => {
    if (role === 'lead')
      return result(invocation.directory, {
        outcome: 'done',
        summary: 'Final checks',
        artifacts: [],
      })
    if (role === 'reviewer')
      return result(invocation.directory, {
        outcome: 'passed',
        summary: 'Passed',
        artifacts: [],
      })
    const [instance] = proofContext(invocation.prompt).instances
    assert.ok(instance)
    evidenceDir = instance.evidenceDir
    await mkdir(join(evidenceDir, 'nested'))
    for (let index = 0; index < 55; index++) {
      const path = join(evidenceDir, 'nested', `${index}.txt`)
      await writeFile(path, `captured ${index}`)
      await utimes(path, 1000 + index, 1000 + index)
    }
    await check(invocation)
    // The declared file is older than every swept file, but must still be kept.
    await utimes(join(evidenceDir, 'check.txt'), 1, 1)
  })
  await next()
  await next()
  const detail = await f.detail(ticket.number)
  const swept = detail.artifacts.filter((a) => a.title.includes(': nested/'))
  assert.equal(swept.length, 50)
  assert.deepEqual(
    swept.map((a) => a.title.split(': nested/')[1]),
    Array.from({ length: 50 }, (_, i) => `${54 - i}.txt`),
  )
  for (const artifact of swept) {
    assert.equal(
      await readFile(artifact.path!, 'utf8'),
      `captured ${artifact.title.split(': nested/')[1]!.split('.')[0]}`,
    )
    assert.ok(artifact.path!.startsWith(join(f.home, 'evidence')))
  }
  assert.equal(
    detail.artifacts.filter((a) => a.title === 'README check').length,
    1,
  )
  const notes = detail.artifacts.filter(
    (a) => a.title === 'Evidence capture limit',
  )
  assert.equal(notes.length, 1)
  assert.match(notes[0]!.content!, /left out 5 files/)
  await assert.rejects(access(evidenceDir))
})

test('one unretainable artifact becomes a note while the result and other files survive', async (t) => {
  const store = await createTestStore()
  t.after(() => store.close())
  const home = await mkdtemp(join(tmpdir(), 'limits-artifacts-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  setArtifactHome(store.database, home)
  const repository = await createRepository(store.database, {
    slug: 'fixture/artifacts',
  })
  await markRepositoryReady(store.database, repository.id)
  const ticket = await createTicket(store.database, {
    repository: repository.slug,
    workflow: await builtInWorkflow('task'),
    title: 'Artifacts',
  })
  const [context] = await claimAttempts(store.database, 1)
  assert.ok(context)
  await markRunning(store.database, context.attempt.id, 'fixture')
  const source = join(home, 'good.txt')
  const missing = join(home, 'missing.txt')
  await writeFile(source, 'Keep this evidence')
  await completeAttempt(store.database, context.attempt.id, {
    outcome: 'done',
    summary: 'Completed despite one missing file',
    artifacts: [
      { kind: 'evidence', title: 'Good before', path: source },
      { kind: 'evidence', title: 'Missing file', path: missing },
      { kind: 'evidence', title: 'Good after', path: source },
      { kind: 'note', title: 'Text still kept', content: 'Result note' },
    ],
  })
  const detail = (await getTicketDetail(store.database, ticket.number))!
  assert.equal(detail.ticket.currentStep, 'test')
  assert.equal(
    detail.attempts[0]!.summary,
    'Completed despite one missing file',
  )
  assert.equal(detail.artifacts.length, 4)
  for (const artifact of detail.artifacts.filter((a) => a.kind === 'evidence'))
    assert.equal(await readFile(artifact.path!, 'utf8'), 'Keep this evidence')
  const note = detail.artifacts.find(
    (a) => a.title === 'Artifact file could not be retained',
  )!
  assert.equal(note.kind, 'note')
  assert.equal(note.path, null)
  assert.ok(note.content!.includes(missing))
  assert.match(note.content!, /Cannot retain artifact: missing/)
  assert.equal(
    (await readdir(join(home, 'evidence', String(ticket.id)))).length,
    2,
  )
  const before = await readdir(join(home, 'evidence', String(ticket.id)))
  await assert.rejects(
    withPreparedArtifacts(
      store.database,
      detail.attempts.at(-1)!.id,
      [
        { kind: 'evidence', title: 'Rollback copy', path: source },
        { kind: 'evidence', title: 'Rollback missing', path: missing },
      ],
      async (artifacts) => {
        assert.equal(artifacts[1]!.kind, 'note')
        throw new Error('Transaction failed')
      },
    ),
    /Transaction failed/,
  )
  assert.deepEqual(
    await readdir(join(home, 'evidence', String(ticket.id))),
    before,
  )
  assert.equal(await readFile(source, 'utf8'), 'Keep this evidence')
})

test('persisted paired passing runs leave final-test limit unused after base re-tests', async (t) => {
  const { f, ticket, next, signal } = await finalFixture(t)
  f.setBehaviour(async (_, invocation) =>
    result(invocation.directory, {
      outcome: 'done',
      summary: 'Final checks',
      artifacts: [],
    }),
  )
  await next()
  const head = await f.workspaces.head(ticket, signal)
  for (let round = 0; round < 3; round++) {
    const [tester] = await claimAttempts(f.database, 1)
    assert.equal(tester!.step.id, 'final-test')
    await markRunning(f.database, tester!.attempt.id, 'fixture')
    const reviewer = await startParallelReview(
      f.database,
      tester!.attempt.id,
      { cli: 'codex', model: 'review' },
      head,
    )
    await completeParallelAttempts(
      f.database,
      tester!.attempt.id,
      reviewer.id,
      {
        result: {
          outcome: round === 2 ? 'changes-needed' : 'passed',
          summary: 'Tester',
          artifacts: [],
        },
        completion: { headCommit: head },
      },
      {
        result: { outcome: 'passed', summary: 'Reviewer', artifacts: [] },
        completion: { headCommit: head },
      },
    )
    if (round < 2) {
      const [maintenance] = await claimAttempts(f.database, 1)
      assert.equal(maintenance!.step.id, 'maintain-pr')
      await markRunning(f.database, maintenance!.attempt.id, 'fixture')
      await completeAttempt(f.database, maintenance!.attempt.id, {
        outcome: 'base-moved',
        summary: 'Base advanced',
        artifacts: [],
      })
    }
  }
  const detail = await f.detail(ticket.number)
  assert.equal(detail.ticket.currentStep, 'lead')
  assert.equal(detail.ticket.status, 'queued')
  assert.equal(runsOf(detail.attempts, 'final-test'), 3)
})

for (const end of ['limit', 'cancel'] as const) {
  test(`${end}: failed child report keeps branch and actual head after worktree cleanup, without pushing`, async (t) => {
    const f = await leadFixture()
    t.after(() => f.close())
    const ticket = await f.lead()
    const signal = AbortSignal.timeout(60_000)
    f.setBehaviour(async (role, invocation) => {
      if (role === 'lead')
        return result(invocation.directory, {
          outcome: 'delegate',
          summary: 'Delegate work',
          tasks: [
            {
              key: 'partial',
              title: 'Partial child',
              instructions: 'Keep partial work',
            },
          ],
          artifacts: [],
        })
      if (role === 'builder')
        return build(invocation, 'partial.txt', 'Reusable work')
      return result(invocation.directory, {
        outcome: 'changes-needed',
        summary: 'Needs correction',
        artifacts: [
          {
            kind: 'finding',
            title: 'Still incomplete',
            content: 'Needs more work',
          },
        ],
      })
    })
    const next = async () => {
      const [context] = await claimAttempts(f.database, 1)
      assert.ok(context)
      await markRunning(f.database, context.attempt.id, 'fixture')
      await runAttempt(f, context, signal)
      return context
    }
    await next()
    const waiting = await next()
    const wait = { attemptId: waiting.attempt.id, ticketNumber: ticket.number }
    await pollTasks(f, wait, signal)
    await next()
    const before = (await f.detail(ticket.number)).tasks[0]!.child!
    const head = await run(
      'git',
      ['rev-parse', `refs/heads/${before.branch}`],
      { cwd: f.workspaces.cache(f.repository), signal },
    )
    if (end === 'limit') await next()
    else
      await cancelTicket(f.database, {
        ticketNumber: before.number,
        reason: 'Use what is already committed',
      })
    const child = await f.detail(before.number)
    assert.equal(child.ticket.status, 'cancelled')
    assert.equal(
      await f.workspaces.cleanup(child.ticket, f.repository, signal),
      true,
    )
    await assert.rejects(access(f.workspaces.path(child.ticket)))
    await pollTasks(f, wait, signal)
    const detail = await f.detail(ticket.number)
    const task = detail.tasks[0]!
    assert.equal(task.status, 'failed')
    assert.ok(task.result!.includes(before.branch))
    assert.ok(task.result!.includes(head))
    const report = detail.artifacts.findLast((a) => a.title === 'Task report')!
    assert.ok(report.content!.includes(before.branch))
    assert.ok(report.content!.includes(head))
    const [lead] = await claimAttempts(f.database, 1)
    const context = await leadContext(f, lead!, detail)
    assert.equal(context.tasks[0]!.child!.branch, before.branch)
    assert.equal(context.tasks[0]!.result, task.result)
    assert.equal(
      await run('git', ['show', `${before.branch}:partial.txt`], {
        cwd: f.workspaces.cache(f.repository),
      }),
      'Reusable work',
    )
    await assert.rejects(
      run('git', ['rev-parse', '--verify', `refs/heads/${before.branch}`], {
        cwd: join(f.root, 'app.git'),
      }),
    )
  })
}

for (const name of ['lead', 'task-pr'] as const) {
  test(`${name}: persisted CI failures stop on third send-back while base-moved re-tests stay exempt`, async (t) => {
    const store = await createTestStore()
    t.after(() => store.close())
    const repository = await createRepository(store.database, {
      slug: `fixture/${name}`,
    })
    await markRepositoryReady(store.database, repository.id)
    const ticket = await createTicket(store.database, {
      repository: repository.slug,
      workflow: await builtInWorkflow(name),
      title: 'Bound CI failures',
    })
    let maintenance = 0
    for (let turns = 0; turns < 50; turns++) {
      const [context] = await claimAttempts(store.database, 1)
      assert.ok(context)
      await markRunning(store.database, context.attempt.id, 'fixture')
      const outcome =
        context.step.id === 'maintain-pr'
          ? ++maintenance % 3 === 0
            ? 'ci-failed'
            : 'base-moved'
          : context.step.kind === 'agent' &&
              ['tester', 'reviewer'].includes(context.step.role)
            ? 'passed'
            : 'done'
      await completeAttempt(store.database, context.attempt.id, {
        outcome,
        summary: outcome,
        artifacts: [],
      })
      if (maintenance === 9) break
    }
    const detail = (await getTicketDetail(store.database, ticket.number))!
    assert.equal(maintenance, 9)
    assert.equal(
      detail.attempts.filter((a) => a.outcome === 'ci-failed').length,
      3,
    )
    assert.equal(
      detail.attempts.filter((a) => a.outcome === 'base-moved').length,
      6,
    )
    assert.equal(
      detail.ticket.status,
      name === 'task-pr' ? 'cancelled' : 'needs-you',
    )
    if (name === 'lead') assert.equal(detail.ticket.waiting!.askReason, 'limit')
  })
}
