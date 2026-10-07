import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import {
  afterParallelResults,
  parallelReviewer,
} from '../src/domain/parallel-final.ts'
import type { AgentInvocation } from '../src/executors/cli.ts'
import { run } from '../src/executors/process.ts'
import { getMergeGate } from '../src/store/merge-gates.ts'
import {
  cancelTicket,
  claimAttempts,
  createTicket,
  interruptRunning,
  markRunning,
  startParallelReview,
} from '../src/store/tickets.ts'
import { runAttempt } from '../src/engine/runner.ts'
import { isLatestTesterVerdictCurrent } from '../src/store/verdicts.ts'
import { proofContext } from './fixtures/proof-agent.ts'
import { build, deferred, leadFixture, packet, result } from './helpers/lead.ts'
import { builtInWorkflow } from './helpers/store.ts'
import { proofFixture } from './helpers/proof.ts'
import { commit } from './helpers/other-repositories.ts'

async function until<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 180_000
  while (true) {
    const value = await read()
    if (predicate(value)) return value
    assert.ok(
      Date.now() < deadline,
      `Condition timed out: ${JSON.stringify(value).slice(0, 4000)}`,
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const reviewers = [
  { cli: 'codex', model: 'review' },
  { cli: 'claude', model: 'review' },
] as const

async function prove(invocation: AgentInvocation, outcome = 'passed') {
  const artifacts = []
  for (const instance of proofContext(invocation.prompt).instances) {
    const response = await fetch(`${instance.url}/checkout`, {
      method: 'POST',
      body: '{}',
    })
    const content = await response.text()
    const path = join(instance.evidenceDir, 'response.json')
    await writeFile(path, JSON.stringify({ status: response.status, content }))
    assert.equal(response.status, instance.surface === 'base' ? 500 : 200)
    artifacts.push({
      kind: 'evidence',
      title: `${instance.surface} response`,
      path,
    })
  }
  await result(invocation.directory, {
    outcome,
    summary: `Tester verdict ${outcome}`,
    artifacts: [
      ...artifacts,
      ...(outcome === 'changes-needed'
        ? [
            {
              kind: 'finding',
              title: 'Tester problem',
              content:
                'Scenario: Acceptance requirement\nObserved: checkout response recorded\nExpected: complete requirement\nEvidence: response.json',
            },
          ]
        : []),
    ],
  })
}

async function finalFixture(t: TestContext) {
  const f = await leadFixture(
    {
      concurrency: 1,
      agents: {
        default: { cli: 'codex', model: 'build' },
        reviewers,
        roles: { tester: { cli: 'claude', model: 'test' } },
      },
    },
    'verify',
  )
  t.after(() => f.close())
  f.library.set('lead', await builtInWorkflow('lead'))
  const ticket = await f.lead()
  const cwd = await f.workspaces.prepare(
    ticket,
    f.repository,
    AbortSignal.timeout(60_000),
  )
  await writeFile(join(cwd, 'feature.txt'), 'feature')
  const head = await commit(cwd, 'Feature')
  return { f, ticket, cwd, head }
}

for (const [tested, reviewed] of [
  ['changes-needed', 'passed'],
  ['passed', 'changes-needed'],
  ['changes-needed', 'changes-needed'],
] as const) {
  test(`concurrent final pair joins once: tester ${tested}, reviewer ${reviewed}`, async (t) => {
    const { f, ticket, head } = await finalFixture(t)
    const testerStarted = deferred()
    const reviewersStarted = deferred()
    const finishReview = deferred()
    const holdLead = deferred()
    let leadRuns = 0
    let reviewRuns = 0
    let wake = ''
    f.setBehaviour(async (role, invocation) => {
      if (role === 'lead') {
        leadRuns++
        if (leadRuns === 2) {
          wake = invocation.prompt
          await holdLead.wait(invocation.signal)
        }
        await result(invocation.directory, {
          outcome: 'done',
          summary: 'Ready for final checks',
          artifacts: [],
        })
      } else if (role === 'tester') {
        testerStarted.release()
        await reviewersStarted.wait(
          AbortSignal.any([invocation.signal, AbortSignal.timeout(60_000)]),
        )
        await prove(invocation, tested)
      } else if (role === 'reviewer') {
        if (++reviewRuns === 2) reviewersStarted.release()
        await testerStarted.wait(
          AbortSignal.any([invocation.signal, AbortSignal.timeout(60_000)]),
        )
        await finishReview.wait(invocation.signal)
        await result(invocation.directory, {
          outcome: reviewed,
          summary: `Reviewer verdict ${reviewed}`,
          artifacts:
            reviewed === 'changes-needed'
              ? [
                  {
                    kind: 'finding',
                    title: 'Serious review problem',
                    content: 'Fix the problem',
                  },
                ]
              : [],
        })
      }
    })
    await f.start()
    const overlapping = await until(
      () => f.detail(ticket.number),
      (d) => d.artifacts.some((a) => a.title === 'head response'),
    )
    const active = overlapping.attempts.filter((a) => a.status === 'running')
    assert.deepEqual(
      active.map((a) => a.stepId),
      ['final-test', 'review'],
    )
    assert.deepEqual(
      active.map((a) => a.headCommit),
      [head, head],
    )
    assert.equal(leadRuns, 1, 'no wake before the reviewer finishes')
    assert.equal(
      reviewRuns,
      2,
      'every configured reviewer starts alongside proof',
    )
    assert.equal(
      new Set(
        f.invocations
          .filter((i) => ['tester', 'reviewer'].includes(i.role))
          .map((i) => i.directory),
      ).size,
      3,
    )
    assert.equal(
      new Set(
        overlapping.artifacts
          .filter((a) => a.kind === 'log')
          .map((a) => a.path),
      ).size,
      overlapping.artifacts.filter((a) => a.kind === 'log').length,
    )
    finishReview.release()
    const joined = await until(
      () => f.detail(ticket.number),
      () => leadRuns === 2 && !!wake,
    )
    const context = packet(wake) as ReturnType<typeof packet> & {
      earlierSteps: { step: string; outcome: string; summary: string }[]
    }
    assert.ok(
      context.earlierSteps.some(
        (s) =>
          s.step === 'final-test' &&
          s.outcome === tested &&
          s.summary.includes('Tester verdict'),
      ),
    )
    assert.ok(
      context.earlierSteps.some(
        (s) =>
          s.step === 'review' &&
          s.outcome === reviewed &&
          s.summary.includes('Reviewer verdict'),
      ),
    )
    assert.equal(joined.attempts.filter((a) => a.stepId === 'lead').length, 2)
    assert.equal(
      joined.attempts.filter(
        (a) =>
          a.status === 'finished' &&
          ['final-test', 'review'].includes(a.stepId),
      ).length,
      2,
    )
    assert.equal(
      joined.attempts
        .filter((a) => ['final-test', 'review'].includes(a.stepId))
        .every((a) => a.next?.to === 'step' && a.next.stepId === 'lead'),
      true,
    )
    if (reviewed === 'changes-needed')
      assert.match(wake, /Serious review problem/)
    assert.deepEqual(f.errors, [])
  })
}

test('both pass: publish at the joined head with current tester/reviewer gate facts', async (t) => {
  const { f, ticket, head } = await finalFixture(t)
  f.setBehaviour(async (role, invocation) => {
    if (role === 'tester') return prove(invocation)
    await result(invocation.directory, {
      outcome: role === 'lead' ? 'done' : 'passed',
      summary: `${role} passed`,
      artifacts: [],
    })
  })
  await f.start()
  const detail = await until(
    () => f.detail(ticket.number),
    (d) => d.ticket.waiting?.for === 'pull-request-merge',
  )
  assert.ok(detail.ticket.pullRequestUrl)
  const verdicts = detail.attempts.filter((a) =>
    ['final-test', 'review'].includes(a.stepId),
  )
  assert.deepEqual(
    verdicts.map((a) => [a.outcome, a.headCommit]),
    [
      ['passed', head],
      ['passed', head],
    ],
  )
  const gate = (await getMergeGate(f.database, ticket.id))!.latest
  assert.equal(gate.ready, true)
  assert.equal(gate.facts.tester!.commit, head)
  assert.equal(gate.facts.reviewer!.commit, head)
  assert.deepEqual(f.errors, [])
})

test('a lead correction through a child commit restarts both verdicts', async (t) => {
  const { f, ticket, head } = await finalFixture(t)
  let leadRuns = 0
  const proofHeads: string[] = []
  const reviewHeads: string[] = []
  f.setBehaviour(async (role, invocation, title) => {
    if (role === 'lead') {
      const round = ++leadRuns
      await result(
        invocation.directory,
        round === 2
          ? {
              outcome: 'delegate',
              summary: 'Correct review finding',
              tasks: [
                {
                  key: 'correction',
                  title: 'Correction',
                  instructions: 'Fix serious problem',
                  land: 'branch',
                },
              ],
              artifacts: [],
            }
          : { outcome: 'done', summary: 'Run final checks', artifacts: [] },
      )
    } else if (role === 'builder') {
      await build(invocation, 'correction.txt', 'corrected')
    } else if (role === 'tester') {
      if (title !== 'Correction')
        proofHeads.push(proofContext(invocation.prompt).instances[0]!.commit)
      await prove(invocation)
    } else if (role === 'reviewer') {
      const current = await run('git', ['rev-parse', 'HEAD'], {
        cwd: invocation.cwd,
      })
      if (title !== 'Correction') reviewHeads.push(current)
      await result(invocation.directory, {
        outcome: current === head ? 'changes-needed' : 'passed',
        summary: 'Review correction',
        artifacts:
          current === head
            ? [
                {
                  kind: 'finding',
                  title: 'Needs correction',
                  content: 'Add correction',
                },
              ]
            : [],
      })
    }
  })
  await f.start()
  const detail = await until(
    () => f.detail(ticket.number),
    (d) => d.ticket.waiting?.for === 'pull-request-merge',
  )
  const verdicts = detail.attempts.filter((a) =>
    ['final-test', 'review'].includes(a.stepId),
  )
  assert.equal(verdicts.length, 4)
  const newHead = verdicts[2]!.headCommit!
  assert.notEqual(newHead, head)
  assert.deepEqual(proofHeads, [head, newHead])
  assert.deepEqual(reviewHeads, [head, head, newHead, newHead])
  assert.equal(
    await isLatestTesterVerdictCurrent(f.database, ticket.id, head),
    false,
  )
  assert.equal(
    await isLatestTesterVerdictCurrent(f.database, ticket.id, newHead),
    true,
  )
  assert.equal(
    (await getMergeGate(f.database, ticket.id))!.latest.facts.reviewer!.commit,
    newHead,
  )
  assert.deepEqual(f.errors, [])
})

test('bug test/review join routes back to fix with both results', async (t) => {
  const f = await proofFixture({
    script: {
      reproducer: [{ proof: true }],
      builder: [{ fixed: true, commit: true }],
      tester: [{ proof: true }],
    },
  })
  t.after(() => f.close())
  // Keep fixture step-driving explicit, but use the production built-in bug definition.
  const ticket = await createTicket(f.store.database, {
    repository: 'fixture/proof',
    workflow: await builtInWorkflow('bug'),
    title: 'Bug pair',
  })
  await cancelTicket(f.store.database, { ticketNumber: f.ticket.number })
  const next = async () => {
    const [context] = await claimAttempts(f.store.database, 1)
    assert.ok(context)
    const running = await markRunning(
      f.store.database,
      context.attempt.id,
      'fixture',
    )
    await runAttempt(
      { ...f.options, parallelFinal: true },
      { ...context, attempt: running },
      AbortSignal.timeout(60_000),
    )
  }
  await next()
  await next()
  const execute = f.options.execute
  f.options.execute = async (invocation) => {
    if (invocation.prompt.startsWith('You are an independent reviewer'))
      return result(invocation.directory, {
        outcome: 'changes-needed',
        summary: 'Bug review problem',
        artifacts: [],
      })
    return execute(invocation)
  }
  await next()
  const { getTicketDetail } = await import('../src/store/tickets.ts')
  const detail = (await getTicketDetail(f.store.database, ticket.number))!
  assert.equal(detail.ticket.currentStep, 'fix')
  const verdicts = detail.attempts.filter((a) =>
    ['test', 'review'].includes(a.stepId),
  )
  assert.deepEqual(
    verdicts.map((a) => a.outcome),
    ['passed', 'changes-needed'],
  )
  assert.equal(verdicts[0]!.headCommit, verdicts[1]!.headCommit)
  assert.ok(verdicts[0]!.reproductionAttemptId)
  assert.equal(
    detail.attempts.filter((a) => a.stepId === 'fix' && a.status === 'pending')
      .length,
    1,
  )
})

test('paired limits retain each finished run and choose stops/corrections before forward exhaustion', async () => {
  const workflow = (await builtInWorkflow('lead')).workflow
  const tester = workflow.steps.find((s) => s.id === 'final-test')!
  assert.equal(parallelReviewer(workflow, tester)!.id, 'review')
  const history = (stepId: string, rounds: number) => [
    ...Array.from(
      { length: rounds - 1 },
      () =>
        ({ stepId, status: 'finished', waitingFor: null, next: null }) as const,
    ),
    { stepId, status: 'running', waitingFor: null, next: null } as const,
  ]
  const pass = { outcome: 'passed', summary: 'Passed', artifacts: [] }
  const fail = { ...pass, outcome: 'changes-needed' }
  assert.deepEqual(
    afterParallelResults(
      workflow,
      history('final-test', 3),
      history('review', 3),
      fail,
      pass,
    ).close.next,
    { to: 'ask', because: 'limit' },
  )
  assert.deepEqual(
    afterParallelResults(
      workflow,
      history('final-test', 5),
      history('review', 5),
      pass,
      fail,
    ).close.next,
    { to: 'step', stepId: 'maintain-pr' },
  )
  assert.deepEqual(
    afterParallelResults(
      workflow,
      history('final-test', 5),
      history('review', 5),
      fail,
      fail,
    ).close.next,
    { to: 'ask', because: 'limit' },
  )
})

test('recovery interrupts both sessions and retries the whole pair only once', async (t) => {
  const { f, ticket, head } = await finalFixture(t)
  f.setBehaviour(async (_, invocation) =>
    result(invocation.directory, {
      outcome: 'done',
      summary: 'Ready',
      artifacts: [],
    }),
  )
  const [lead] = await claimAttempts(f.database, 1)
  await markRunning(f.database, lead!.attempt.id, 'fixture')
  await runAttempt(f, lead!, AbortSignal.timeout(60_000))
  for (let round = 0; round < 2; round++) {
    const [tester] = await claimAttempts(f.database, 1)
    assert.equal(tester!.step.id, 'final-test')
    await markRunning(f.database, tester!.attempt.id, 'fixture')
    await startParallelReview(
      f.database,
      tester!.attempt.id,
      reviewers[0],
      head,
    )
    await interruptRunning(f.database)
    const detail = await f.detail(ticket.number)
    assert.equal(
      detail.attempts.filter(
        (a) =>
          ['final-test', 'review'].includes(a.stepId) &&
          a.status === 'interrupted',
      ).length,
      (round + 1) * 2,
    )
    assert.equal(detail.ticket.status, round === 0 ? 'queued' : 'needs-you')
  }
})

test('a branch change during the pair rejects both old verdicts; retry checks the new head', async (t) => {
  const { f, ticket, cwd, head } = await finalFixture(t)
  const holdTester = deferred()
  let tested = false
  let moved = false
  f.setBehaviour(async (role, invocation) => {
    if (role === 'tester') {
      await prove(invocation)
      tested = true
      if (!moved) await holdTester.wait(invocation.signal)
    } else {
      await result(invocation.directory, {
        outcome: role === 'lead' ? 'done' : 'passed',
        summary: 'Passed',
        artifacts: [],
      })
    }
  })
  await f.start()
  await until(
    () => f.detail(ticket.number),
    () => tested,
  )
  await writeFile(join(cwd, 'external.txt'), 'New branch work')
  const newHead = await commit(cwd, 'Concurrent update')
  moved = true
  holdTester.release()
  const stale = await until(
    () => f.detail(ticket.number),
    (d) => d.ticket.status === 'needs-you',
  )
  assert.equal(
    stale.attempts.find((a) => a.stepId === 'final-test')!.headCommit,
    head,
  )
  assert.equal(
    stale.attempts.find((a) => a.stepId === 'review')!.headCommit,
    head,
  )
  assert.equal(
    stale.attempts.some(
      (a) =>
        ['final-test', 'review'].includes(a.stepId) && a.outcome === 'passed',
    ),
    false,
  )
  assert.match(
    stale.attempts.find((a) => a.stepId === 'final-test')!.error!,
    /branch moved during proof/,
  )
  const { resolveAsk } = await import('../src/store/tickets.ts')
  await resolveAsk(f.database, {
    ticketNumber: ticket.number,
    attemptId: stale.ticket.waiting!.attemptId,
    resolution: { action: 'retry' },
  })
  const fresh = await until(
    () => f.detail(ticket.number),
    (d) => d.ticket.waiting?.for === 'pull-request-merge',
  )
  const verdicts = fresh.attempts.filter(
    (a) =>
      ['final-test', 'review'].includes(a.stepId) &&
      a.status === 'finished' &&
      a.waitingFor === null,
  )
  assert.deepEqual(
    verdicts.map((a) => [a.outcome, a.headCommit]),
    [
      ['passed', newHead],
      ['passed', newHead],
    ],
  )
  assert.deepEqual(f.errors, [])
})

for (const failing of ['tester', 'reviewer'] as const) {
  test(`paired ${failing} exhaustion retains limits and publishing behaviour`, async (t) => {
    const { f, ticket, head } = await finalFixture(t)
    f.setBehaviour(async (role, invocation) => {
      if (role === 'tester')
        return prove(invocation, failing === role ? 'changes-needed' : 'passed')
      await result(invocation.directory, {
        outcome:
          role === 'lead'
            ? 'done'
            : failing === role
              ? 'changes-needed'
              : 'passed',
        summary: `${role} verdict`,
        artifacts:
          role === failing
            ? [
                {
                  kind: 'finding',
                  title: 'Unresolved problem',
                  content: 'Serious problem',
                },
              ]
            : [],
      })
    })
    await f.start()
    const detail = await until(
      () => f.detail(ticket.number),
      (d) =>
        failing === 'tester'
          ? d.ticket.waiting?.askReason === 'limit'
          : d.ticket.waiting?.for === 'pull-request-merge',
    )
    const rounds = failing === 'tester' ? 3 : 5
    for (const step of ['final-test', 'review'])
      assert.equal(
        detail.attempts.filter(
          (a) =>
            a.stepId === step &&
            a.status === 'finished' &&
            a.waitingFor === null,
        ).length,
        rounds,
      )
    if (failing === 'reviewer') {
      assert.ok(detail.ticket.pullRequestUrl)
      const gate = (await getMergeGate(f.database, ticket.id))!.latest
      assert.equal(gate.ready, false)
      assert.equal(gate.facts.reviewer!.commit, head)
      assert.equal(gate.facts.reviewer!.outcome, 'changes-needed')
    }
    assert.deepEqual(f.errors, [])
  })
}

test('base-moved maintenance restarts the pair at the synchronized head', async (t) => {
  const { f, ticket, head } = await finalFixture(t)
  f.setBehaviour(async (role, invocation) => {
    if (role === 'tester') return prove(invocation)
    await result(invocation.directory, {
      outcome: role === 'lead' ? 'done' : 'passed',
      summary: 'Passed',
      artifacts: [],
    })
  })
  await f.start()
  const published = await until(
    () => f.detail(ticket.number),
    (d) => d.ticket.waiting?.for === 'pull-request-merge',
  )
  await f.stop()
  const source = join(f.root, 'app')
  await writeFile(join(source, 'base-update.txt'), 'Advanced base')
  await commit(source, 'Advance base')
  await run('git', ['push', join(f.root, 'app.git'), 'main'], { cwd: source })
  const { requeuePullRequestMaintenance } =
    await import('../src/store/tickets.ts')
  await requeuePullRequestMaintenance(
    f.database,
    published.ticket.waiting!.attemptId,
    'Base advanced',
  )
  await f.start()
  const fresh = await until(
    () => f.detail(ticket.number),
    (d) =>
      d.ticket.waiting?.for === 'pull-request-merge' &&
      d.attempts.filter(
        (a) => a.stepId === 'final-test' && a.status === 'finished',
      ).length === 2,
  )
  const verdicts = fresh.attempts.filter((a) =>
    ['final-test', 'review'].includes(a.stepId),
  )
  assert.equal(verdicts.length, 4)
  assert.notEqual(verdicts[2]!.headCommit, head)
  assert.equal(verdicts[2]!.headCommit, verdicts[3]!.headCommit)
  assert.ok(
    fresh.attempts.some(
      (a) =>
        a.stepId === 'maintain-pr' &&
        a.outcome === 'base-moved' &&
        a.next?.to === 'step' &&
        a.next.stepId === 'final-test',
    ),
  )
  assert.equal(
    (await getMergeGate(f.database, ticket.id))!.latest.facts.reviewer!.commit,
    verdicts[2]!.headCommit,
  )
  assert.deepEqual(f.errors, [])
})
