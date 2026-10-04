// Only this test server exposes fixture creation; production API routes are unchanged.
import { serve } from '@hono/node-server'
import { rm, writeFile } from 'node:fs/promises'
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
  { close: () => Promise<void>; disconnect: () => void }
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
    artifactTicket: artifactTicketNumber,
  })
})
router.post('/__test/disconnect', async (c) => {
  const { url } = await c.req.json<{ url: string }>()
  fixtures.get(url)?.disconnect()
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
