import { mergePolicy } from '../../src/domain/auto-merge.ts'
import { getMergeGate } from '../../src/store/merge-gates.ts'
import {
  markMergeRequested,
  markMergeResult,
} from '../../src/store/auto-merge.ts'
import { setAutoMerge } from '../../src/store/repositories.ts'
import {
  recordMergedPR,
  pendingPostMergeChecks,
  finishPostMergeCheck,
} from '../../src/store/post-merge.ts'
import { listWaitingForMerge } from '../../src/store/tickets.ts'
import { decide, linkOtherRepository } from '../../src/store/tickets.ts'
import { decisionWorkflow, confirmDecision } from '../helpers/decisions.ts'
import { recordDecisionOutcome } from '../../src/store/tickets.ts'
import {
  parkForTasks,
  startTask,
  updateTask,
  listTasks,
} from '../../src/store/tasks.ts'
// Only this test server exposes fixture creation; production API routes are unchanged.
import { serve } from '@hono/node-server'
import { appendFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createApp } from '../../src/api/app.ts'
import { BUILT_WEB_APP } from '../../src/server.ts'
import { listenForEvents } from '../../src/store/events.ts'
import {
  claimAttempts,
  completeAttempt,
  createTicket,
  markRunning,
  getTicketDetail,
  addAttemptArtifacts,
} from '../../src/store/tickets.ts'
import { createDemoStore } from '../helpers/demo.ts'
import { builtInLibrary, builtInWorkflow } from '../helpers/store.ts'

const port = Number(process.env['KSF_E2E_PORT'])
if (!process.env['KSF_TEST_DATABASE_URL'] || !port)
  throw new Error('Run through npm run test:e2e')
const store = await createDemoStore()
const events = listenForEvents(store.database)
await events.ready
const home = store.home
const app = createApp({
  database: store.database,
  library: await builtInLibrary(),
  events,
  home,
  webRoot: BUILT_WEB_APP,
})
const fixtures = new Map<
  string,
  {
    close: () => Promise<void>
    disconnect: () => void
    updateLog: (finish: boolean) => Promise<void>
    gate: (state: string, number?: number) => Promise<void>
    autoMerge: () => Promise<void>
    prune: () => Promise<void>
  }
>()
// Register before the app's static fallback by composing a small fixture router.
const { Hono } = await import('hono')
const router = new Hono()
router.post('/__test/fixtures', async (c) => {
  const fixture = await createDemoStore()
  const fixtureHome = fixture.home
  const verdict = c.req.query('verdict')
  if (verdict === 'changes-needed' || verdict === 'unobserved') {
    const detail = await getTicketDetail(
      fixture.database,
      fixture.tickets.proofStale,
    )
    const attempt = detail!.attempts.at(-1)!
    await completeAttempt(
      fixture.database,
      attempt.id,
      {
        outcome: verdict === 'changes-needed' ? 'changes-needed' : 'passed',
        summary:
          verdict === 'changes-needed'
            ? 'The cart total does not update.'
            : 'Legacy test passed without a commit observation.',
        artifacts:
          verdict === 'changes-needed'
            ? [
                {
                  kind: 'finding',
                  title: 'Cart total finding',
                  content:
                    '## Quantity change\n\n**Blocking:** changing quantity leaves the total unchanged.\n\n<script>window.unsafe = true</script>',
                },
              ]
            : [],
      },
      verdict === 'changes-needed' ? { headCommit: 'b'.repeat(40) } : {},
    )
  }
  await writeFile(
    join(fixtureHome, 'planner.log'),
    'Planner started\nPlan ready\n<script>unsafe()</script>\n' +
      'Verification output line\n'.repeat(80),
  )
  await writeFile(
    join(fixtureHome, 'plan.md'),
    '## Safe plan\n\n- [x] Markdown works\n\n<script>window.unsafe = true</script>\n\n[Bad link](javascript:alert(1))',
  )
  const running = await getTicketDetail(
    fixture.database,
    fixture.tickets.running,
  )
  const runningAttempt = running!.attempts.at(-1)!
  await writeFile(join(fixtureHome, 'running.log'), 'Agent started\n')
  await addAttemptArtifacts(fixture.database, runningAttempt.id, [
    { kind: 'log', title: 'Live agent log', path: 'running.log' },
  ])
  const runningLog = (await getTicketDetail(
    fixture.database,
    fixture.tickets.running,
  ))!.artifacts.find((a) => a.title === 'Live agent log')!.path!
  let artifactTicketNumber: number | null = null
  if (c.req.query('artifacts') === 'true') {
    const artifactTicket = await createTicket(fixture.database, {
      repository: 'kipster/demo-shop',
      workflow: await builtInWorkflow('quick-change'),
      title: 'Inspect artifacts safely',
      lightsOut: true,
      body: 'A **safe** description.',
    })
    const claimed = await claimAttempts(fixture.database, 100)
    const attempt = claimed.find(
      (item) => item.ticket.number === artifactTicket.number,
    )!
    await markRunning(fixture.database, attempt.attempt.id, 'codex')
    await completeAttempt(fixture.database, attempt.attempt.id, {
      outcome: 'done',
      summary: 'Plan and log ready.',
      artifacts: [
        {
          kind: 'plan',
          title: 'Safety plan',
          path: 'plan.md',
        },
        { kind: 'log', title: 'Planner log', path: 'planner.log' },
        {
          kind: 'decision',
          title: 'Storage choice',
          chose: 'PostgreSQL',
          alternative: 'A file',
          reason: 'Keep writes transactional',
        },
      ],
    })
    artifactTicketNumber = artifactTicket.number
  }
  let decisionTicket: number | null = null
  if (c.req.query('decisions') === 'true') {
    const created = await createTicket(fixture.database, {
      repository: 'kipster/demo-shop',
      workflow: await decisionWorkflow(),
      title: 'Check the cart correction',
    })
    const claimed = await claimAttempts(fixture.database, 100)
    const context = claimed.find((item) => item.ticket.id === created.id)!
    await markRunning(fixture.database, context.attempt.id, 'system')
    await recordDecisionOutcome(
      fixture.database,
      context.attempt.id,
      confirmDecision,
    )
    decisionTicket = created.number
  }
  if (c.req.query('autoMerge') === 'true') {
    const detail = (await getTicketDetail(
      fixture.database,
      fixture.tickets.proofPassed,
    ))!
    await setAutoMerge(fixture.database, detail.ticket.repository.id, true)
  }
  let linkedTickets: { original: number; linked: number } | null = null
  if (c.req.query('links') === 'true') {
    const original = await createTicket(fixture.database, {
      repository: 'kipster/demo-shop',
      workflow: await builtInWorkflow('quick-change'),
      title: 'Use the library API',
      dependencies: ['kipster/legacy-api'],
    })
    const claimed = await claimAttempts(fixture.database, 100)
    const context = claimed.find((item) => item.ticket.id === original.id)!
    await markRunning(fixture.database, context.attempt.id, 'codex')
    await completeAttempt(fixture.database, context.attempt.id, {
      outcome: 'done',
      summary: 'Plan ready',
      artifacts: [
        { kind: 'plan', title: 'Plan', content: 'Use the library API.' },
      ],
    })
    let detail = (await getTicketDetail(fixture.database, original.number))!
    await decide(fixture.database, {
      ticketNumber: original.number,
      attemptId: detail.ticket.waiting!.attemptId,
      choice: 'approved',
    })
    const build = (await claimAttempts(fixture.database, 100)).find(
      (item) => item.ticket.id === original.id,
    )!
    await markRunning(fixture.database, build.attempt.id, 'codex')
    const link = await linkOtherRepository(
      fixture.database,
      build.attempt.id,
      {
        outcome: 'needs-other-repo',
        summary: 'Need the API first',
        artifacts: [],
        otherRepository: {
          repository: 'kipster/invalid-kit',
          title: 'Expose the library API',
          body: 'The caller needs a new API.',
          workflow: 'quick-change',
        },
      },
      await builtInWorkflow('quick-change'),
      'a'.repeat(40),
    )
    detail = (await getTicketDetail(fixture.database, link.linked.number))!
    linkedTickets = { original: original.number, linked: detail.ticket.number }
  }
  let taskTickets: { lead: number; child: number } | null = null
  if (c.req.query('tasks') === 'true') {
    const lead = await createTicket(fixture.database, {
      repository: 'kipster/demo-shop',
      workflow: await builtInWorkflow('lead'),
      title: 'Build the export feature',
    })
    const first = (await claimAttempts(fixture.database, 100)).find(
      (item) => item.ticket.id === lead.id,
    )!
    await markRunning(fixture.database, first.attempt.id, 'claude')
    await completeAttempt(fixture.database, first.attempt.id, {
      outcome: 'delegate',
      summary: 'Split into the endpoint and the docs',
      artifacts: [],
      tasks: [
        {
          key: 'api-export',
          title: 'Add the export endpoint',
          instructions: 'Add GET /export returning CSV.',
          agent: { cli: 'claude', model: 'opus', effort: 'high' },
        },
        {
          key: 'docs',
          title: 'Document the export',
          instructions: 'Describe the export in the README.',
          land: 'pr',
        },
        {
          key: 'schema',
          title: 'Add the export schema',
          instructions: 'Describe the CSV columns.',
        },
        {
          key: 'fixtures',
          title: 'Seed export fixtures',
          instructions: 'Add sample rows for the export.',
        },
      ],
    })
    const run = (await claimAttempts(fixture.database, 100)).find(
      (item) => item.ticket.id === lead.id,
    )!
    await markRunning(fixture.database, run.attempt.id, 'system')
    await parkForTasks(fixture.database, run.attempt.id)
    const [api, docs, schema, seed] = await listTasks(fixture.database, lead.id)
    await updateTask(
      fixture.database,
      schema!.id,
      'merged',
      'Merged into the lead branch at 61ccc186062039d6c465d4e2f965cc5cf61d6814.',
    )
    await updateTask(
      fixture.database,
      seed!.id,
      'failed',
      'Build failed: invalid or missing result.json after two runs. No work was produced.',
    )
    const child = await startTask(
      fixture.database,
      api!.id,
      {
        repository: 'kipster/demo-shop',
        workflow: await builtInWorkflow('task'),
        title: api!.title,
        body: api!.instructions,
      },
      null,
    )
    await startTask(
      fixture.database,
      docs!.id,
      {
        repository: 'kipster/demo-shop',
        workflow: await builtInWorkflow('task-pr'),
        title: docs!.title,
        body: docs!.instructions,
      },
      null,
    )
    await updateTask(
      fixture.database,
      docs!.id,
      'pr-ready',
      'Pull request ready for a decision.',
    )
    taskTickets = { lead: lead.number, child: child!.number }
  }
  const fixtureEvents = listenForEvents(fixture.database)
  await fixtureEvents.ready
  const fixtureApp = createApp({
    database: fixture.database,
    library: await builtInLibrary(),
    events: fixtureEvents,
    home: fixtureHome,
    webRoot: BUILT_WEB_APP,
    allowedOrigins: [`http://127.0.0.1:${port}`, 'null'],
  })
  const fixtureServer = await new Promise<ReturnType<typeof serve>>(
    (resolve) => {
      const listening = serve(
        { fetch: fixtureApp.fetch, port: 0, hostname: '127.0.0.1' },
        () => resolve(listening),
      )
    },
  )
  const address = fixtureServer.address()
  if (!address || typeof address === 'string')
    throw new Error('No fixture port')
  const url = `http://127.0.0.1:${address.port}`
  const disconnect = () => {
    if ('closeAllConnections' in fixtureServer)
      fixtureServer.closeAllConnections()
  }
  fixtures.set(url, {
    disconnect,
    autoMerge: async () => {
      const detail = (await getTicketDetail(
        fixture.database,
        fixture.tickets.proofPassed,
      ))!
      const gate = (await getMergeGate(fixture.database, detail.ticket.id))!
        .latest
      const context = (await listWaitingForMerge(fixture.database)).find(
        (ctx) => ctx.ticket.id === detail.ticket.id,
      )!
      if (mergePolicy(true, gate) !== 'merge')
        throw new Error('Gate requires owner or more proof')
      if (!(await markMergeRequested(fixture.database, context, gate)))
        throw new Error('Merge has not been authorized')
      await markMergeResult(fixture.database, detail.ticket.id, gate.facts.head)
      await recordMergedPR(
        fixture.database,
        context,
        {
          url: detail.ticket.pullRequestUrl!,
          state: 'MERGED',
          headRefOid: gate.facts.head,
          mergeCommit: { oid: 'd'.repeat(40) },
        },
        true,
      )
      await completeAttempt(
        fixture.database,
        context.attempt.id,
        { outcome: 'merged', summary: 'Merged by factory', artifacts: [] },
        { headCommit: gate.facts.head },
      )
      const check = (await pendingPostMergeChecks(fixture.database))[0]!
      await finishPostMergeCheck(
        fixture.database,
        check,
        'failed',
        {
          state: 'failed',
          failures: [
            {
              name: 'Default branch test',
              url: '',
              excerpt:
                'Fixture proves the failure path without breaking a real branch.',
            },
          ],
        },
        await builtInWorkflow('bug'),
      )
    },
    gate: async (state, number = fixture.tickets.proofPassed) => {
      const { saveMergeGate } = await import('../../src/store/merge-gates.ts')
      const { evaluateMergeGate } =
        await import('../../src/domain/merge-gate.ts')
      const detail = (await getTicketDetail(fixture.database, number))!
      const proven = (await getTicketDetail(
        fixture.database,
        fixture.tickets.proofPassed,
      ))!
      const facts = (await getMergeGate(fixture.database, proven.ticket.id))!
        .latest.facts
      const ci =
        state === 'failed'
          ? 'failed'
          : state.startsWith('pending')
            ? 'pending'
            : 'passed'
      const untested = state === 'pending-untested'
      await saveMergeGate(
        fixture.database,
        detail.ticket.id,
        evaluateMergeGate(
          {
            ...facts,
            ci,
            checks: [
              {
                name: 'Demo repository checks',
                state: ci,
                required: true,
                url: '',
              },
            ],
            paths:
              state === 'paths'
                ? [
                    '.kipster/kit.yml',
                    'db/migrations/001.sql',
                    '.github/workflows/ci.yml',
                  ]
                : [],
            behind: state === 'behind' ? 2 : 0,
            localHead: facts.head,
            buildWork: false,
            hasTester: !untested,
            tester: untested
              ? null
              : { status: 'finished', outcome: 'passed', commit: facts.head },
            mergeable:
              state === 'pending-conflict' ? 'CONFLICTING' : 'MERGEABLE',
            hasReviewer: state !== 'unreviewed',
            reviewer: {
              status: 'finished',
              outcome: 'passed',
              commit: facts.head,
              ...(state === 'reviewer-owner'
                ? { ownerReview: { reason: 'Changes public API behavior' } }
                : {}),
            },
          },
          new Date().toISOString(),
        ),
      )
    },
    prune: async () => {
      const { pruneEvidence } = await import('../../src/store/evidence.ts')
      const detail = (await getTicketDetail(
        fixture.database,
        fixture.tickets.proofPassed,
      ))!
      await completeAttempt(
        fixture.database,
        detail.ticket.waiting!.attemptId,
        { outcome: 'merged', summary: 'Owner merged', artifacts: [] },
        { headCommit: 'a'.repeat(40) },
      )
      await pruneEvidence(
        fixture.database,
        fixtureHome,
        30,
        new Date(Date.now() + 31 * 86400000),
      )
    },
    updateLog: async (finish) => {
      await appendFile(
        runningLog,
        finish ? 'Agent finished\n' : 'Agent made progress\n',
      )
      if (finish)
        await completeAttempt(fixture.database, runningAttempt.id, {
          outcome: 'done',
          summary: 'Plan ready.',
          artifacts: [
            { kind: 'plan', title: 'Plan', content: 'Fix the typo.' },
          ],
        })
    },
    close: async () => {
      await fixtureEvents.close()
      disconnect()
      await new Promise<void>((resolve) => fixtureServer.close(() => resolve()))
      await fixture.close()
      await rm(fixtureHome, { recursive: true, force: true })
    },
  })
  return c.json({
    url,
    tickets: fixture.tickets,
    linkedTickets,
    taskTickets,
    artifactTicket: artifactTicketNumber,
    decisionTicket,
  })
})
router.post('/__test/auto-merge', async (c) => {
  const { url } = await c.req.json<{ url: string }>()
  await fixtures.get(url)?.autoMerge()
  return c.json({ ok: true })
})
router.post('/__test/gate', async (c) => {
  const { url, state, number } = await c.req.json<{
    url: string
    state: string
    number?: number
  }>()
  await fixtures.get(url)?.gate(state, number)
  return c.json({ ok: true })
})
router.post('/__test/prune', async (c) => {
  const { url } = await c.req.json<{ url: string }>()
  await fixtures.get(url)?.prune()
  return c.json({ ok: true })
})
router.post('/__test/disconnect', async (c) => {
  const { url } = await c.req.json<{ url: string }>()
  fixtures.get(url)?.disconnect()
  return c.json({ ok: true })
})
router.post('/__test/update-log', async (c) => {
  const { url, finish = false } = await c.req.json<{
    url: string
    finish?: boolean
  }>()
  await fixtures.get(url)?.updateLog(finish)
  return c.json({ ok: true })
})
router.post('/__test/dispose', async (c) => {
  const { url } = await c.req.json<{ url: string }>()
  await fixtures.get(url)?.close()
  fixtures.delete(url)
  return c.json({ ok: true })
})
router.route('/', app)
const server = serve({ fetch: router.fetch, port, hostname: '127.0.0.1' })
console.log(`e2e factory at http://127.0.0.1:${port}`)
let closing = false
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    if (closing) return
    closing = true
    void (async () => {
      if ('closeAllConnections' in server) server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await Promise.all(
        [...fixtures.values()].map((fixture) => fixture.close()),
      )
      await events.close()
      await store.close()
      await rm(home, { recursive: true, force: true })
    })()
  })
