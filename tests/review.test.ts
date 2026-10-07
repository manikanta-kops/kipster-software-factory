import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  independentAgent,
  DEFAULT_SETTINGS,
  settingsSchema,
  settingsProblems,
} from '../src/domain/settings.ts'
import { loadLibrary } from '../src/library/library.ts'
import { getMergeGate } from '../src/store/merge-gates.ts'
import { setAutoMerge } from '../src/store/repositories.ts'
import { proofContext } from './fixtures/proof-agent.ts'
import {
  build,
  deferred,
  leadFixture,
  leadState,
  result,
  until,
} from './helpers/lead.ts'

const builder = { cli: 'codex', model: 'build' } as const
const pair = [
  { cli: 'codex', model: 'review' },
  { cli: 'claude', model: 'review' },
] as const

test('independence ignores effort, distinguishes absent models, and preserves candidate order', () => {
  assert.deepEqual(
    independentAgent(
      { ...builder, effort: 'high' },
      [builder],
      [{ ...builder, effort: 'low' }, pair[1], pair[0]],
    ),
    { agent: pair[1], replaced: true, independent: true },
  )
  assert.equal(
    independentAgent({ cli: 'codex' }, [builder], []).independent,
    true,
  )
  assert.deepEqual(independentAgent(builder, [builder], [builder]), {
    agent: builder,
    replaced: false,
    independent: false,
  })
})

test('old settings parse and same-family reviewers warn without limiting list length', () => {
  const { reviewers: _, ...agents } = DEFAULT_SETTINGS.agents
  assert.deepEqual(
    settingsSchema.parse({ ...DEFAULT_SETTINGS, agents }).agents.reviewers,
    [],
  )
  const settings = settingsSchema.parse({
    ...DEFAULT_SETTINGS,
    workflows: { lead: { reviewers: [pair[0], pair[0], pair[1]] } },
  })
  assert.match(
    settingsProblems(settings, ['lead'])[0]!,
    /warning: reviewers share a CLI model family/,
  )
})

async function reviewFixture(limit: number) {
  const f = await leadFixture(
    { agents: { default: builder, reviewers: pair } },
    'verify',
  )
  const directory = join(f.root, 'review-workflows')
  await mkdir(directory)
  await writeFile(
    join(directory, 'lead.yml'),
    `name: lead
description: Final review fixture
steps:
  - id: lead
    kind: agent
    role: lead
    routes:
      delegate: run
      done: review
  - id: run
    kind: system
    action: run-tasks
    limit: 20
    routes:
      reported: lead
  - id: review
    kind: agent
    role: reviewer
    limit: ${limit}
    routes:
      changes-needed: lead
      limit: maintain-pr
  - id: maintain-pr
    kind: system
    action: maintain-pr
    with:
      ciSettleMinutes: 0
  - id: merge
    kind: system
    action: merge
`,
  )
  await writeFile(
    join(directory, 'task.yml'),
    `name: task
description: Build a branch task
steps:
  - id: build
    kind: agent
    role: builder
`,
  )
  const loaded = await loadLibrary(directory)
  assert.ok(loaded.ok, loaded.ok ? '' : loaded.errors.join())
  f.library.set('lead', loaded.library.get('lead')!)
  f.library.set('task', loaded.library.get('task')!)
  await setAutoMerge(f.store.database, f.repository.id, true)
  return f
}

// Round 2 of `kept` has one finding per reason a finding stays serious: it was
// raised before, its file changed since round 1, or it names no file.
const kept = [
  { title: 'Original finding', file: 'README.md' },
  { title: 'New finding', file: 'changed.txt' },
  { title: 'Unfiled finding' },
] as const

for (const scenario of ['unchanged', 'kept'] as const) {
  test(`parallel lead reviewers: ${scenario}`, async (t) => {
    const f = await reviewFixture(scenario === 'kept' ? 2 : 5)
    t.after(() => f.close())
    let round = 0
    let count = 0
    let blocked = deferred()
    const rounds: { agents: string[]; directory: string[]; heads: string[] }[] =
      []
    f.setBehaviour(async (role, invocation, title) => {
      if (role === 'builder') return build(invocation, 'changed.txt', title)
      if (role === 'lead') {
        const { tasks } = leadState(invocation.prompt)
        if (!tasks.length || (round === 1 && tasks.length === 1))
          return result(invocation.directory, {
            outcome: 'delegate',
            summary: 'Build or fix review findings',
            artifacts: [],
            tasks: [
              {
                key: `fix${tasks.length}`,
                title: `Fix ${tasks.length}`,
                instructions: 'Update changed.txt',
                land: 'branch',
              },
            ],
          })
        return result(invocation.directory, {
          outcome: tasks.some((task) => task.status !== 'merged')
            ? 'delegate'
            : 'done',
          summary: 'Tasks ready',
          artifacts: [],
        })
      }
      if (title !== 'Lead the change')
        return result(invocation.directory, {
          outcome: 'passed',
          summary: 'Child passed',
          artifacts: [],
        })
      if (count % 2 === 0) {
        round++
        blocked = deferred()
        rounds.push({ agents: [], directory: [], heads: [] })
      }
      const current = rounds.at(-1)!
      current.agents.push(invocation.config.cli)
      current.directory.push(invocation.directory)
      count++
      const { run } = await import('../src/executors/process.ts')
      current.heads.push(
        await run('git', ['rev-parse', 'HEAD'], { cwd: invocation.cwd }),
      )
      if (current.heads.length === 2) blocked.release()
      await blocked.wait(invocation.signal)
      if (round > 1) {
        assert.match(
          invocation.prompt,
          /Review only whether each earlier finding was fixed/,
        )
        assert.match(invocation.prompt, new RegExp(rounds[0]!.heads[0]!))
      }
      const fails = invocation.config.cli === 'claude'
      const findings =
        round === 1
          ? [
              {
                title: 'Original finding',
                file: scenario === 'kept' ? 'README.md' : 'changed.txt',
              },
            ]
          : scenario === 'kept'
            ? kept
            : [{ title: 'New finding', file: 'README.md' }]
      return result(invocation.directory, {
        outcome: fails ? 'changes-needed' : 'passed',
        summary: fails ? 'Serious correction needed' : 'Passed',
        artifacts: fails
          ? findings.map((finding) => ({
              kind: 'finding',
              ...finding,
              content: 'Correct this serious problem.',
            }))
          : [],
        ...(invocation.config.cli === 'codex'
          ? { ownerReview: { reason: 'Public contract deserves review' } }
          : {}),
      })
    })
    const ticket = await f.lead()
    const expected = 2
    await f.start()
    for (let review = 1; review <= expected; review++)
      await until(
        async () => round,
        (observedRound) => observedRound >= review,
      )
    const detail = await until(
      async () => {
        if (f.errors.length) throw new Error(f.errors.map(String).join('\n'))
        const observed = await f.detail(ticket.number)
        if (
          observed.ticket.status === 'needs-you' &&
          observed.ticket.waiting?.for === 'ask'
        )
          throw new Error(
            JSON.stringify({
              ticket: observed.ticket,
              attempts: observed.attempts,
              errors: f.errors.map(String),
            }),
          )
        return {
          ...observed,
          mergeGate: await getMergeGate(f.store.database, observed.ticket.id),
        }
      },
      (d) => !!d.mergeGate && !d.mergeGate.latest.facts.buildWork,
    )
    const reviews = detail.attempts.filter(
      (attempt) => attempt.stepId === 'review' && attempt.status === 'finished',
    )
    assert.equal(reviews.length, 2)
    assert.equal(reviews[0]!.outcome, 'changes-needed')
    assert.equal(
      reviews.at(-1)!.outcome,
      scenario === 'unchanged' ? 'passed' : 'changes-needed',
    )
    assert.ok(
      detail.attempts.filter((attempt) => attempt.stepId === 'lead').length >=
        2,
    )
    for (const current of rounds) {
      assert.deepEqual(current.agents.sort(), ['claude', 'codex'])
      assert.equal(new Set(current.heads).size, 1)
      assert.equal(new Set(current.directory).size, 2)
      assert.match(current.directory[0]!, /\/1\/[01]$/)
    }
    const gate = detail.mergeGate!.latest
    if (scenario === 'unchanged') {
      assert.ok(
        detail.artifacts.some(
          (artifact) =>
            artifact.kind === 'note' &&
            artifact.title.includes('New finding') &&
            artifact.file === 'README.md',
        ),
      )
      assert.ok(reviews.at(-1)!.ownerReview?.reason.includes('Public contract'))
    } else {
      for (const finding of kept) {
        const artifact = detail.artifacts.find(
          (a) =>
            a.attemptId === reviews[1]!.id &&
            a.title === `[claude · review] ${finding.title}`,
        )
        assert.ok(artifact, finding.title)
        assert.equal(artifact.kind, 'finding', finding.title)
        assert.equal(
          artifact.file,
          'file' in finding ? finding.file : undefined,
        )
      }
      assert.ok(
        gate.blockers.includes(
          'Reviewer verdict is not passing at the current head',
        ),
      )
      assert.equal(gate.ready, false)
      const description = detail.artifacts.findLast(
        (artifact) => artifact.title === 'Pull request description',
      )!.content!
      assert.match(description, /## Open review findings/)
      for (const finding of kept)
        assert.ok(description.includes(finding.title), finding.title)
    }
    assert.deepEqual(f.errors, [])
  })
}

for (const candidates of [true, false]) {
  test(`reviewer and tester independence: ${candidates ? 'replacement' : 'no candidate'}`, async (t) => {
    const f = await leadFixture(
      { agents: { default: builder, allowed: candidates ? [pair[1]] : [] } },
      'verify',
    )
    t.after(() => f.close())
    const directory = join(f.root, 'independence-workflows')
    await mkdir(directory)
    await writeFile(
      join(directory, 'independent.yml'),
      `name: independent
description: Independence fixture
steps:
  - id: build
    kind: agent
    role: builder
  - id: test
    kind: agent
    role: tester
    needs: [verify]
  - id: review
    kind: agent
    role: reviewer
  - id: maintain-pr
    kind: system
    action: maintain-pr
    with:
      ciSettleMinutes: 0
  - id: merge
    kind: system
    action: merge
`,
    )
    const loaded = await loadLibrary(directory)
    assert.ok(loaded.ok)
    await setAutoMerge(f.store.database, f.repository.id, !candidates)
    f.setBehaviour(async (role, invocation) => {
      if (role === 'builder') return build(invocation, 'feature.txt', 'Feature')
      const artifacts = []
      if (role === 'tester') {
        const instance = proofContext(invocation.prompt).instances[0]!
        const response = await fetch(`${instance.url}/checkout`, {
          method: 'POST',
          body: '{}',
        })
        assert.equal(response.status, 200)
        const path = join(instance.evidenceDir, 'checkout.txt')
        await writeFile(path, await response.text())
        artifacts.push({ kind: 'evidence', title: 'Checkout', path })
      }
      return result(invocation.directory, {
        outcome: 'passed',
        summary: 'Passed',
        artifacts,
      })
    })
    const { createTicket } = await import('../src/store/tickets.ts')
    const ticket = await createTicket(f.store.database, {
      repository: f.repository.slug,
      workflow: loaded.library.get('independent')!,
      title: 'Independent proof',
    })
    await f.start()
    const detail = await until(
      async () => {
        if (f.errors.length) throw new Error(f.errors.map(String).join('\n'))
        const observed = await f.detail(ticket.number)
        if (
          observed.ticket.status === 'needs-you' &&
          observed.ticket.waiting?.for === 'ask'
        )
          throw new Error(
            JSON.stringify({
              ticket: observed.ticket,
              attempts: observed.attempts,
              errors: f.errors.map(String),
            }),
          )
        return {
          ...observed,
          mergeGate: await getMergeGate(f.store.database, observed.ticket.id),
        }
      },
      (d) => !!d.mergeGate && !d.mergeGate.latest.facts.buildWork,
    )
    for (const role of ['tester', 'reviewer']) {
      const invocation = f.invocations.find((item) => item.role === role)!
      assert.deepEqual(invocation.config, candidates ? pair[1] : builder)
      const execution = detail.attempts.find(
        (attempt) => attempt.stepId === (role === 'tester' ? 'test' : 'review'),
      )!
      assert.deepEqual(execution.agent, invocation.config)
    }
    if (candidates) {
      for (const role of ['tester', 'reviewer'])
        assert.ok(
          detail.artifacts.some(
            (a) =>
              a.title === `${role} agent replaced for independence` &&
              a.content!.includes('codex · build') &&
              a.content!.includes('claude · review'),
          ),
        )
    } else {
      for (const reason of [
        'Review was not independent',
        'Testing was not independent',
      ]) {
        assert.ok(
          detail.artifacts.some((artifact) => artifact.title === reason),
        )
        assert.ok(detail.mergeGate!.latest.needsOwner.includes(reason))
      }
      assert.equal(detail.mergeGate!.latest.ready, true)
    }
    assert.deepEqual(f.errors, [])
  })
}
