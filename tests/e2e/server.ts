import { decide, linkOtherRepository } from '../../src/store/tickets.ts'
import { decisionWorkflow, confirmDecision } from '../helpers/decisions.ts'
import { recordDecisionOutcome } from '../../src/store/tickets.ts'
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
    gate: (state: string) => Promise<void>
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
    gate: async (state) => {
      const { getMergeGate, saveMergeGate } =
        await import('../../src/store/merge-gates.ts')
      const { evaluateMergeGate } =
        await import('../../src/domain/merge-gate.ts')
      const detail = (await getTicketDetail(
        fixture.database,
        fixture.tickets.proofPassed,
      ))!
      const facts = (await getMergeGate(fixture.database, detail.ticket.id))!
        .latest.facts
      const ci =
        state === 'failed'
          ? 'failed'
          : state === 'pending'
            ? 'pending'
            : 'passed'
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
    artifactTicket: artifactTicketNumber,
    decisionTicket,
  })
})
router.post('/__test/gate', async (c) => {
  const { url, state } = await c.req.json<{ url: string; state: string }>()
  await fixtures.get(url)?.gate(state)
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
