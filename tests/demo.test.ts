import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { after, before, describe, test } from 'node:test'
import { seedDemo } from '../scripts/demo-data.ts'
import {
  checkerVerdict,
  uncheckedItems,
  untestedReasons,
} from '../src/domain/task-testing.ts'
import { mergedTaskResult } from '../src/engine/tasks.ts'
import {
  createRepository,
  getRepository,
  listRepositories,
} from '../src/store/repositories.ts'
import { getMergeGate } from '../src/store/merge-gates.ts'
import { getTicketDetail, listTickets } from '../src/store/tickets.ts'
import { createDemoStore } from './helpers/demo.ts'
import { WorkflowInUse } from '../src/domain/errors.ts'
import {
  listUploadedWorkflows,
  removeUploadedWorkflow,
} from '../src/store/workflows.ts'
import { acquireSchedulerLock } from '../src/store/scheduler.ts'
import { startFactory } from '../src/server.ts'
import { builtInLibrary, createTestStore } from './helpers/store.ts'

let demo: Awaited<ReturnType<typeof createDemoStore>>

before(async () => {
  demo = await createDemoStore()
})

after(() => demo.close())

async function detail(number: number) {
  const found = await getTicketDetail(demo.database, number)
  assert.ok(found, `ticket #${number}`)
  return found
}

describe('demo data', () => {
  test('has a ready, a pending and a failed repository', async () => {
    const repositories = await listRepositories(demo.database)
    assert.deepEqual(
      repositories.map((repository) => [repository.slug, repository.status]),
      [
        ['kipster/demo-shop', 'ready'],
        ['kipster/docs-site', 'ready'],
        ['kipster/invalid-kit', 'ready'],
        ['kipster/legacy-api', 'failed'],
        ['kipster/website', 'pending'],
      ],
    )
  })

  test('has a ticket in every state', async () => {
    const { tickets } = demo
    const expected = [
      [tickets.queued, 'queued', null],
      [tickets.running, 'running', null],
      [tickets.approvePlan, 'needs-you', 'human'],
      [tickets.askAfterLimit, 'needs-you', 'ask'],
      [tickets.planToApprove, 'needs-you', 'human'],
      [tickets.planToChange, 'needs-you', 'human'],
      [tickets.planToReject, 'needs-you', 'human'],
      [tickets.askToRetry, 'needs-you', 'ask'],
      [tickets.askToMove, 'needs-you', 'ask'],
      [tickets.askToCancel, 'needs-you', 'ask'],
      [tickets.waitingForMerge, 'needs-you', 'pull-request-merge'],
      [tickets.done, 'done', null],
      [tickets.bundleFailed, 'queued', null],
      [tickets.bundlePending, 'needs-you', 'pull-request-merge'],
      [tickets.bundleLateFailed, 'queued', null],
      [tickets.checkedWithoutVerifyLead, 'needs-you', 'pull-request-merge'],
      [tickets.checkedWithVerifyLead, 'needs-you', 'pull-request-merge'],
      [tickets.checkedWithoutVerifyChild, 'done', null],
      [tickets.checkedWithVerifyChild, 'done', null],
      [tickets.cancelled, 'cancelled', null],
    ] as const
    for (const [number, status, waitingFor] of expected) {
      const { ticket } = await detail(number)
      assert.equal(ticket.status, status, `#${number}`)
      assert.equal(ticket.waiting?.for ?? null, waitingFor, `#${number}`)
    }
    assert.equal((await listTickets(demo.database)).length, 29)
  })

  test('retired quick-change keeps its stored workflow and completed plan', async () => {
    const { ticket, workflow, attempts, artifacts } = await detail(
      demo.tickets.retiredWorkflow,
    )
    assert.equal(ticket.title, 'Historical quick-change ticket')
    assert.equal(ticket.repository.slug, 'kipster/demo-shop')
    assert.equal(ticket.lightsOut, false)
    assert.equal(ticket.status, 'needs-you')
    assert.equal(ticket.currentStep, 'approve-plan')
    assert.equal(ticket.waiting?.for, 'human')
    assert.equal(workflow.name, 'quick-change')
    assert.equal(workflow.steps.length, 6)
    assert.partialDeepStrictEqual(workflow.steps, [
      { id: 'plan', kind: 'agent', role: 'planner' },
      {
        id: 'approve-plan',
        kind: 'human',
        routes: { 'changes-needed': 'plan' },
      },
      { id: 'build', kind: 'agent', role: 'builder' },
      {
        id: 'review',
        kind: 'agent',
        role: 'reviewer',
        limit: 2,
        routes: { 'changes-needed': 'build' },
      },
      {
        id: 'maintain-pr',
        kind: 'system',
        action: 'maintain-pr',
        routes: {
          conflict: 'build',
          'ci-failed': 'build',
          'base-moved': 'review',
        },
      },
      { id: 'merge', kind: 'system', action: 'merge' },
    ])
    const planAttempt = attempts.find((attempt) => attempt.stepId === 'plan')
    assert.ok(planAttempt)
    assert.equal(planAttempt.status, 'finished')
    assert.equal(planAttempt.outcome, 'done')
    assert.equal(planAttempt.summary, 'Historical plan ready.')
    assert.ok(planAttempt.finishedAt)
    const plan = artifacts.find((artifact) => artifact.kind === 'plan')
    assert.ok(plan)
    assert.equal(plan.attemptId, planAttempt.id)
    assert.equal(plan.title, 'Historical plan')
    assert.match(plan.content ?? '', /Retain the old workflow history/)
    assert.equal((await builtInLibrary()).get('quick-change'), undefined)
  })

  test('an uploaded workflow in use by a running ticket and a lead task child cannot be removed', async () => {
    const { uploadRunning, uploadLead, uploadChild } = demo.tickets
    const running = await detail(uploadRunning)
    const lead = await detail(uploadLead)
    const child = await detail(uploadChild)
    assert.equal(running.ticket.status, 'running')
    assert.equal(running.workflow.name, 'synthetic-review')
    assert.equal(lead.workflow.name, 'lead')
    assert.equal(lead.ticket.waiting?.for, 'tasks')
    assert.equal(lead.tasks[0]?.workflow, 'synthetic-review')
    assert.equal(lead.tasks[0]?.child?.number, uploadChild)
    assert.equal(child.ticket.status, 'running')
    assert.equal(child.workflow.name, 'synthetic-review')
    assert.deepEqual(
      (await listUploadedWorkflows(demo.database)).map(({ name }) => name),
      ['synthetic-review'],
    )
    await assert.rejects(
      removeUploadedWorkflow(demo.database, 'synthetic-review'),
      (error) =>
        error instanceof WorkflowInUse &&
        error.tickets.join() ===
          [uploadRunning, uploadLead, uploadChild].join(),
    )
    assert.equal((await listUploadedWorkflows(demo.database)).length, 1)
  })

  test('lights-out demo exposes typed decisions and a linked child without running agents', async () => {
    const lead = await detail(demo.tickets.lightsOutLead)
    const child = await detail(demo.tickets.lightsOutChild)
    assert.equal(lead.ticket.lightsOut, true)
    assert.equal(lead.ticket.waiting?.for, 'tasks')
    assert.equal(child.ticket.lightsOut, true)
    assert.equal(child.parentTask?.parent.number, lead.ticket.number)
    assert.equal(lead.tasks[0]?.child?.number, child.ticket.number)
    assert.equal(lead.tasks[0]?.status, 'parked')
    assert.deepEqual(
      lead.artifacts.find((artifact) => artifact.kind === 'decision')?.decision,
      {
        chose: 'CSV',
        alternative: 'An Excel workbook',
        reason:
          'CSV works with the existing report data and common spreadsheet tools.',
      },
    )
    assert.deepEqual(
      child.artifacts.find((artifact) => artifact.kind === 'decision')
        ?.decision,
      {
        chose: 'Use the displayed report column order',
        alternative: 'Sort columns alphabetically',
        reason: 'Matching the report makes the export familiar to shop owners.',
      },
    )
    assert.equal(child.attempts.at(-1)?.stepId, 'build')
    assert.equal(child.attempts.at(-1)?.status, 'waiting')
    assert.equal(child.ticket.waiting?.askReason, 'needs-decision')
    const untested = await detail(demo.tickets.lightsOutUntestedChild)
    assert.equal(untested.ticket.lightsOut, true)
    assert.equal(untested.ticket.status, 'done')
    assert.deepEqual(untested.ticket.skippedSteps, [])
    assert.deepEqual(untestedReasons(untested), [
      'Unverified by test: Read the export docs',
    ])
    assert.equal(lead.tasks[1]?.status, 'merged')
    assert.equal(
      lead.tasks[1]?.result,
      mergedTaskResult('f'.repeat(40), checkerVerdict(untested)),
    )
    assert.equal(
      lead.tasks[1]?.result,
      `Merged into the lead branch at ${'f'.repeat(40)}. Checker test passed with unverified items. Unverified by test: Read the export docs.`,
    )
  })

  const steps = (
    attempts: readonly { stepId: string; outcome: string | null }[],
  ) => attempts.map((attempt) => [attempt.stepId, attempt.outcome])

  async function checkedTicket(leadNumber: number, childNumber: number) {
    const lead = await detail(leadNumber)
    const child = await detail(childNumber)
    const library = await builtInLibrary()
    assert.equal(lead.ticket.lightsOut, true)
    assert.equal(child.ticket.lightsOut, true)
    assert.deepEqual(lead.workflow, library.get('lead')?.workflow)
    assert.deepEqual(child.workflow, library.get('task')?.workflow)
    assert.equal(child.parentTask?.parent.number, leadNumber)
    assert.equal(lead.tasks[0]?.child?.number, childNumber)
    assert.equal(lead.tasks[0]?.status, 'merged')
    // The tester ran from real routing: nothing was skipped.
    assert.deepEqual(child.ticket.skippedSteps, [])
    assert.equal(child.ticket.status, 'done')
    assert.deepEqual(steps(child.attempts), [
      ['build', 'done'],
      ['test', 'passed'],
    ])
    // The lead's done routed into its final check.
    assert.deepEqual(steps(lead.attempts).slice(-6), [
      ['run-tasks', 'reported'],
      ['lead', 'done'],
      ['final-test', 'passed'],
      ['review', 'passed'],
      ['maintain-pr', 'ready'],
      ['merge', null],
    ])
    assert.equal(lead.ticket.waiting?.for, 'pull-request-merge')
    return { lead, child }
  }

  test('a task in a repository without verify is still checked, and so is the final change', async () => {
    const { lead, child } = await checkedTicket(
      demo.tickets.checkedWithoutVerifyLead,
      demo.tickets.checkedWithoutVerifyChild,
    )
    const repository = await getRepository(demo.database, 'kipster/docs-site')
    assert.equal(repository?.kit.status, 'valid')
    assert.equal(repository?.kit.capabilities.includes('verify'), false)
    assert.equal(child.ticket.repository.slug, 'kipster/docs-site')
    const check = child.attempts.at(-1)!
    assert.deepEqual(
      uncheckedItems(child).map((artifact) => [
        artifact.attemptId,
        artifact.scenario,
        artifact.scenarioResult,
      ]),
      [[check.id, 'Open the rate limit page in a browser', 'unverified']],
    )
    assert.equal(
      lead.tasks[0]?.result,
      mergedTaskResult('2'.repeat(40), checkerVerdict(child)),
    )
    assert.equal(
      lead.tasks[0]?.result,
      `Merged into the lead branch at ${'2'.repeat(40)}. Checker test passed at ${'1'.repeat(40)} with unverified items. Unverified by test: Open the rate limit page in a browser.`,
    )
    assert.deepEqual(untestedReasons(lead), [
      'Unverified by final-test: Open the rate limit page in a browser',
    ])
  })

  test('a task in a repository with verify is checked as before', async () => {
    const { lead, child } = await checkedTicket(
      demo.tickets.checkedWithVerifyLead,
      demo.tickets.checkedWithVerifyChild,
    )
    assert.equal(child.ticket.repository.slug, 'kipster/demo-shop')
    const repository = await getRepository(demo.database, 'kipster/demo-shop')
    assert.ok(repository?.kit.capabilities.includes('verify'))
    assert.deepEqual(uncheckedItems(child), [])
    assert.deepEqual(
      child.artifacts.map((artifact) => artifact.scenarioResult),
      ['passed'],
    )
    assert.equal(
      lead.tasks[0]?.result,
      mergedTaskResult('4'.repeat(40), checkerVerdict(child)),
    )
    assert.equal(
      lead.tasks[0]?.result,
      `Merged into the lead branch at ${'4'.repeat(40)}. Checker test passed at ${'3'.repeat(40)}.`,
    )
    assert.deepEqual(untestedReasons(lead), [])
  })

  test('the merge gate is untested only when the checker reported an unverified item', async () => {
    const without = await detail(demo.tickets.checkedWithoutVerifyLead)
    const withVerify = await detail(demo.tickets.checkedWithVerifyLead)
    const untested = (await getMergeGate(demo.database, without.ticket.id))!
      .latest
    const checked = (await getMergeGate(demo.database, withVerify.ticket.id))!
      .latest
    const reason =
      'Unverified by final-test: Open the rate limit page in a browser'
    assert.deepEqual(untested.facts.untestedReasons, untestedReasons(without))
    assert.deepEqual(untested.facts.untestedReasons, [reason])
    assert.deepEqual(untested.needsOwner, [reason])
    assert.deepEqual(untested.blockers, [])
    assert.equal(untested.ready, true)
    assert.deepEqual(checked.facts.untestedReasons, [])
    assert.deepEqual(checked.needsOwner, [])
    assert.deepEqual(checked.blockers, [])
    assert.equal(checked.ready, true)
    const sameInputs = (facts: typeof checked.facts) =>
      JSON.parse(
        JSON.stringify({ ...facts, untestedReasons: [] }).replaceAll(
          facts.head,
          'head',
        ),
      )
    assert.deepEqual(sameInputs(untested.facts), sameInputs(checked.facts))
  })

  test('the plan waiting for approval is a markdown artifact', async () => {
    const { ticket, artifacts } = await detail(demo.tickets.approvePlan)
    assert.equal(ticket.waiting?.stepId, 'approve-plan')
    const plan = artifacts.find((artifact) => artifact.kind === 'plan')
    assert.match(plan?.content ?? '', /## Acceptance scenarios/)
  })

  test('the ask explains the review limit, with findings and comments attached', async () => {
    const { ticket, artifacts } = await detail(demo.tickets.askAfterLimit)
    assert.equal(ticket.waiting?.askReason, 'limit')
    assert.deepEqual(
      artifacts.map((artifact) => artifact.kind),
      ['plan', 'comment', 'plan', 'finding', 'finding'],
    )
  })

  test('each plan and ask owner action has its own waiting ticket', async () => {
    const { tickets } = demo
    const plans = [
      tickets.approvePlan,
      tickets.planToApprove,
      tickets.planToChange,
      tickets.planToReject,
    ]
    const asks = [
      tickets.askAfterLimit,
      tickets.askToRetry,
      tickets.askToMove,
      tickets.askToCancel,
    ]
    assert.equal(new Set([...plans, ...asks]).size, 8)
    for (const number of plans) {
      const { ticket, artifacts } = await detail(number)
      assert.equal(ticket.waiting?.stepId, 'approve-plan', `#${number}`)
      assert.match(
        artifacts.find((artifact) => artifact.kind === 'plan')?.content ?? '',
        /## Acceptance scenarios/,
      )
    }
    for (const number of asks.slice(1)) {
      const { ticket, workflow, artifacts } = await detail(number)
      assert.equal(ticket.waiting?.askReason, 'limit', `#${number}`)
      assert.equal(ticket.currentStep, 'review')
      assert.ok(workflow.steps.some((step) => step.id === 'lead'))
      assert.deepEqual(
        artifacts.map((artifact) => artifact.kind),
        ['plan', 'finding', 'finding'],
      )
    }
  })

  test('the running and merge-waiting tickets look real', async () => {
    const running = await detail(demo.tickets.running)
    assert.equal(running.attempts.at(-1)?.executor, 'claude-code')
    const merge = await detail(demo.tickets.waitingForMerge)
    assert.match(merge.ticket.pullRequestUrl ?? '', /\/pull\/42$/)
  })

  test('a failed non-required check sends the ticket back to build through maintain-pr', async () => {
    const { ticket, attempts, artifacts } = await detail(
      demo.tickets.bundleFailed,
    )
    const mergeGate = await getMergeGate(demo.database, ticket.id)
    assert.equal(ticket.title, 'Bundle check failed on the pull request')
    assert.equal(ticket.currentStep, 'build')
    const maintain = attempts.findLast((a) => a.stepId === 'maintain-pr')
    assert.equal(maintain?.outcome, 'ci-failed')
    assert.equal(maintain?.summary, 'CI failed: Bundle')
    assert.equal(attempts.at(-1)?.stepId, 'build')
    assert.equal(attempts.at(-1)?.status, 'pending')
    const finding = artifacts.find((a) => a.attemptId === maintain?.id)
    assert.equal(finding?.kind, 'finding')
    assert.equal(finding?.title, 'CI failed: Bundle')
    assert.match(
      finding?.content ?? '',
      /^\[Bundle\]\(https:\/\/github\.com\/kipster\/demo-shop\/actions\/runs\/440\/job\/442\)/,
    )
    assert.match(finding?.content ?? '', /over the 250 kB budget/)
    assert.equal(mergeGate?.latest.facts.ci, 'failed')
    assert.ok(mergeGate?.latest.blockers.includes('CI failed'))
    assert.deepEqual(
      mergeGate?.latest.facts.checks.map((c) => [c.name, c.state, c.required]),
      [
        ['Demo repository checks', 'passed', true],
        ['Bundle', 'failed', false],
      ],
    )
  })

  test('a pending non-required check is not awaited', async () => {
    const { ticket, attempts } = await detail(demo.tickets.bundlePending)
    const mergeGate = await getMergeGate(demo.database, ticket.id)
    assert.equal(ticket.title, 'Optional check still running')
    const maintain = attempts.findLast((a) => a.stepId === 'maintain-pr')
    assert.equal(maintain?.outcome, 'ready')
    assert.equal(
      maintain?.summary,
      'Pull request: https://github.com/kipster/demo-shop/pull/45. CI passed.',
    )
    assert.equal(ticket.currentStep, 'merge')
    assert.equal(mergeGate?.latest.facts.ci, 'passed')
    assert.equal(mergeGate?.latest.ready, true)
    assert.deepEqual(
      mergeGate?.latest.facts.checks.map((c) => [c.name, c.state, c.required]),
      [
        ['Demo repository checks', 'passed', true],
        ['Bundle', 'pending', false],
      ],
    )
  })

  test('an optional check that fails during the merge wait sends the ticket back to build through merge', async () => {
    const { ticket, attempts, artifacts } = await detail(
      demo.tickets.bundleLateFailed,
    )
    const mergeGate = await getMergeGate(demo.database, ticket.id)
    assert.equal(ticket.title, 'Bundle check failed while waiting to merge')
    assert.match(ticket.body, /Synthetic demo.*No real GitHub or agents ran/s)
    assert.equal(ticket.currentStep, 'build')
    const maintain = attempts.findLast((a) => a.stepId === 'maintain-pr')
    assert.equal(maintain?.outcome, 'ready')
    assert.equal(
      maintain?.summary,
      'Pull request: https://github.com/kipster/demo-shop/pull/48. CI passed.',
    )
    const merge = attempts.findLast((a) => a.stepId === 'merge')
    assert.equal(merge?.outcome, 'changes-needed')
    assert.equal(merge?.summary, 'CI failed: Bundle')
    assert.equal(merge?.headCommit, '9'.repeat(40))
    assert.equal(attempts.at(-1)?.stepId, 'build')
    assert.equal(attempts.at(-1)?.status, 'pending')
    assert.equal(
      artifacts.filter((a) => a.attemptId === maintain?.id).length,
      0,
    )
    const finding = artifacts.find((a) => a.attemptId === merge?.id)
    assert.equal(finding?.kind, 'finding')
    assert.equal(finding?.title, 'CI failed: Bundle')
    assert.match(
      finding?.content ?? '',
      /^\[Bundle\]\(https:\/\/github\.com\/kipster\/demo-shop\/actions\/runs\/480\/job\/482\)\n\n/,
    )
    assert.match(
      finding?.content ?? '',
      /dist\/assets\/vendor\.js is 410\.2 kB, over the 250 kB budget/,
    )
    assert.equal(mergeGate?.latest.facts.ci, 'failed')
    assert.ok(mergeGate?.latest.blockers.includes('CI failed'))
    assert.deepEqual(
      mergeGate?.latest.facts.checks.map((c) => [c.name, c.state, c.required]),
      [
        ['Demo repository checks', 'passed', true],
        ['Bundle', 'failed', false],
      ],
    )
  })

  test('refuses to seed twice', async () => {
    await assert.rejects(
      seedDemo(demo.database, await builtInLibrary()),
      /already has demo data/,
    )
  })
})

test('demo database refuses a scheduler before recovery or repository work', async () => {
  for (let retry = 0; retry < 10; retry++) {
    await assert.rejects(
      acquireSchedulerLock(demo.database, () => {}, 'demo'),
      /already has demo data/,
    )
    await assert.rejects(
      acquireSchedulerLock(demo.database, () => {}),
      /Demo data.*--no-scheduler/,
    )
  }
  assert.equal(
    (await detail(demo.tickets.running)).attempts.at(-1)?.status,
    'running',
  )
})

test('seed CLI retains and serves demo evidence with a relative home', async (t) => {
  const store = await createTestStore()
  const directory = await mkdtemp(join(tmpdir(), 'ksf-relative-demo-'))
  let factory: Awaited<ReturnType<typeof startFactory>> | undefined
  t.after(async () => {
    await factory?.close()
    await store.close()
    await rm(directory, { recursive: true, force: true })
  })
  const home = join(await realpath(directory), '.local', 'verification-home')
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      fileURLToPath(new URL('../scripts/seed-demo.ts', import.meta.url)),
      '--database-url',
      store.url,
      '--home',
      '.local/verification-home',
    ],
    { cwd: directory, timeout: 60_000 },
  )
  assert.match(stdout, /Seeded demo tickets:/)
  assert.match(stdout, /#\d+  retiredWorkflow/)
  const available = createServer()
  available.listen(0, '127.0.0.1')
  await once(available, 'listening')
  const address = available.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve) => available.close(() => resolve()))
  factory = await startFactory({
    databaseUrl: store.url,
    home,
    port: address.port,
    scheduler: false,
  })
  const tickets = await listTickets(store.database)
  const proof = tickets.find(
    (ticket) => ticket.title === 'Cart quantity changes are proven',
  )
  assert.ok(proof)
  const detail = await getTicketDetail(store.database, proof.number)
  assert.ok(detail)
  const files = detail.artifacts.filter((artifact) => artifact.path !== null)
  assert.equal(files.length, 3)
  const evidenceRoot = join(await realpath(home), 'evidence')
  for (const artifact of files) {
    assert.ok(artifact.path!.startsWith(`${evidenceRoot}/`))
    const response = await fetch(`${factory.url}/api/artifacts/${artifact.id}`)
    assert.equal(response.status, 200)
    assert.ok((await response.arrayBuffer()).byteLength > 0)
    assert.ok(
      response.headers.get('content-type')?.startsWith(artifact.mediaType!),
    )
  }
})

test('seeding refuses an active scheduler and leaves the database empty', async (t) => {
  const store = await createTestStore()
  t.after(() => store.close())
  const lock = await acquireSchedulerLock(store.database, () => {})
  try {
    await assert.rejects(
      seedDemo(store.database, await builtInLibrary(), demo.home),
      /scheduler lock/,
    )
    assert.deepEqual(await listRepositories(store.database), [])
  } finally {
    await lock.close()
  }
  await seedDemo(store.database, await builtInLibrary(), demo.home)
  await assert.rejects(
    acquireSchedulerLock(store.database, () => {}),
    /Demo data/,
  )
})

test('API-only factory serves demo data without advancing it', async () => {
  const factory = await startFactory({
    databaseUrl: demo.url,
    port: 0,
    scheduler: false,
  })
  await factory.close()
  assert.equal(
    (await detail(demo.tickets.running)).attempts.at(-1)?.status,
    'running',
  )
})

test('demo seeding refuses existing real repositories without marking their database as demo', async (t) => {
  const store = await createTestStore()
  t.after(() => store.close())
  await createRepository(store.database, { slug: 'real/project' })
  await assert.rejects(
    seedDemo(store.database, await builtInLibrary(), demo.home),
    /empty database/,
  )
  const lock = await acquireSchedulerLock(store.database, () => {})
  await lock.close()
  assert.equal((await listRepositories(store.database)).length, 1)
})

test('serve CLI accepts --no-scheduler and refuses demo scheduling by default', async () => {
  const available = createServer()
  available.listen(0, '127.0.0.1')
  await once(available, 'listening')
  const address = available.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve) => available.close(() => resolve()))
  const args = [
    'src/cli.ts',
    'serve',
    '--database-url',
    demo.url,
    '--port',
    String(address.port),
  ]
  const refused = spawn(process.execPath, args)
  let error = ''
  refused.stderr.on('data', (data) => {
    error += data
  })
  const [code] = await once(refused, 'exit')
  assert.equal(code, 1)
  assert.match(error, /Demo data.*--no-scheduler/)
  const child = spawn(process.execPath, [...args, '--no-scheduler'])
  const exited = once(child, 'exit')
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('CLI did not serve')),
        60_000,
      )
      child.stdout.on('data', (data) => {
        if (String(data).includes('running at')) {
          clearTimeout(timer)
          resolve()
        }
      })
      child.once('exit', () => {
        clearTimeout(timer)
        reject(new Error('CLI exited before serving'))
      })
    })
    const response = await fetch(`http://127.0.0.1:${address.port}/api/tickets`)
    assert.equal(response.status, 200)
    assert.equal(
      (await detail(demo.tickets.running)).attempts.at(-1)?.status,
      'running',
    )
  } finally {
    child.kill('SIGTERM')
    await exited
  }
})

test('demo includes valid/invalid kits and current/stale feature verdicts with playable media files', async () => {
  const repositories = await listRepositories(demo.database)
  assert.equal(
    repositories.find((r) => r.slug === 'kipster/demo-shop')!.kit.status,
    'valid',
  )
  assert.equal(
    repositories.find((r) => r.slug === 'kipster/invalid-kit')!.kit.status,
    'invalid',
  )
  for (const [number, stale] of [
    [demo.tickets.proofPassed, false],
    [demo.tickets.proofStale, true],
  ] as const) {
    const proof = await detail(number)
    assert.equal(proof.ticket.workflow.name, 'lead')
    const verdict = proof.attempts.find(
      (a) => a.stepId === 'final-test' && a.outcome === 'passed',
    )!
    const latest = proof.attempts.findLast((a) => a.headCommit !== null)!
    assert.equal(verdict.headCommit !== latest.headCommit, stale)
    assert.deepEqual(
      proof.artifacts
        .filter((a) => a.attemptId === verdict.id)
        .map((a) => a.mediaType),
      ['image/png', 'video/webm', 'text/plain'],
    )
  }
})
