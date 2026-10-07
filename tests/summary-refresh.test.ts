import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { startFactory } from '../src/server.ts'
import type { TicketSummary } from '../src/domain/summary.ts'
import {
  getTicketDetail,
  listTickets,
  refreshReplacedSummaries,
} from '../src/store/tickets.ts'
import { createDemoStore } from './helpers/demo.ts'

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

async function listed(number: number) {
  const found = (await listTickets(demo.database)).find(
    (ticket) => ticket.number === number,
  )
  assert.ok(found, `ticket #${number}`)
  return found
}

async function store(number: number, summary: TicketSummary) {
  await demo.database.query(
    `UPDATE tickets SET summary = $2, summary_at = '2026-01-01T00:00:00Z'
     WHERE number = $1`,
    [number, JSON.stringify(summary)],
  )
}

/** The summary the code before replacement awareness stored for the demo's replaced lead. */
function beforeUpgrade(current: TicketSummary): TicketSummary {
  return {
    ...current,
    status: 'blocked',
    issues: ['Task export-fix: failed'],
    happened: current.happened.replace('1 replaced', '1 failed'),
  }
}

async function summaryEvents(number: number) {
  return (await detail(number)).events.filter(
    (event) => event.kind === 'ticket.summary',
  ).length
}

async function lessonCount() {
  const { rows } = await demo.database.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM lessons',
  )
  return rows[0]!.count
}

async function freePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

describe('refreshing summaries stored before replacement awareness', () => {
  test('server start refreshes a stored pre-replacement summary', async () => {
    const { replacedLead } = demo.tickets
    await store(
      replacedLead,
      beforeUpgrade((await detail(replacedLead)).ticket.summary!),
    )
    const factory = await startFactory({
      databaseUrl: demo.url,
      home: demo.home,
      port: await freePort(),
      scheduler: false,
    })
    try {
      const summary = (await listed(replacedLead)).summary!
      assert.equal(summary.status, 'needs-you')
      assert.match(summary.happened, /1 replaced/)
    } finally {
      await factory.close()
    }
  })

  test('a lead blocked only by a replaced task needs the owner again on Today and its page', async () => {
    const { replacedLead, replacedChild, replacementChild, approvePlan } =
      demo.tickets
    const current = (await detail(replacedLead)).ticket.summary!
    assert.match(current.happened, /1 replaced/)
    const old = beforeUpgrade(current)
    assert.match(old.happened, /1 failed/)
    await store(replacedLead, old)
    assert.equal((await listed(replacedLead)).summary!.status, 'blocked')
    assert.equal((await detail(replacedLead)).ticket.summary!.status, 'blocked')

    const untouched = (await detail(approvePlan)).ticket
    assert.ok(untouched.summary)
    assert.equal((await detail(approvePlan)).tasks.length, 0)
    await store(approvePlan, { ...untouched.summary, happened: 'stale' })
    const untouchedAt = (await detail(approvePlan)).ticket.summaryAt
    const events = await summaryEvents(replacedLead)
    const lessons = await lessonCount()

    assert.deepEqual(await refreshReplacedSummaries(demo.database), [
      replacedLead,
    ])

    for (const summary of [
      (await listed(replacedLead)).summary!,
      (await detail(replacedLead)).ticket.summary!,
    ]) {
      assert.equal(summary.status, 'needs-you')
      assert.deepEqual(summary.issues, [])
      assert.match(summary.happened, /1 replaced/)
      assert.doesNotMatch(summary.happened, /failed/)
    }
    const refreshed = await detail(replacedLead)
    assert.ok(
      Date.parse(refreshed.ticket.summaryAt!) >
        Date.parse('2026-01-01T00:00:00Z'),
    )
    assert.equal(await summaryEvents(replacedLead), events + 1)
    assert.equal(await lessonCount(), lessons)
    assert.equal(
      (await detail(replacedChild)).parentTask?.replacedBy,
      replacementChild,
    )
    const unchanged = (await detail(approvePlan)).ticket
    assert.equal(unchanged.summary!.happened, 'stale')
    assert.equal(unchanged.summaryAt, untouchedAt)
  })

  test('a second run writes nothing', async () => {
    const { replacedLead } = demo.tickets
    const before = (await detail(replacedLead)).ticket
    const events = await summaryEvents(replacedLead)
    assert.deepEqual(await refreshReplacedSummaries(demo.database), [])
    const after = (await detail(replacedLead)).ticket
    assert.equal(after.summaryAt, before.summaryAt)
    assert.deepEqual(after.summary, before.summary)
    assert.equal(await summaryEvents(replacedLead), events)
  })

  test('a failed task with no replacement keeps its lead blocked', async () => {
    const { replacedLead } = demo.tickets
    const lead = await detail(replacedLead)
    const first = lead.tasks[0]!
    await demo.database.query(
      `INSERT INTO tasks (ticket_id, attempt_id, key, title, instructions, land, workflow, status, result)
       VALUES ($1, $2, 'docs', 'Document the export', 'Describe the CSV download.', 'branch', $3, 'failed', 'Synthetic failure.')`,
      [lead.ticket.id, first.attemptId, first.workflow],
    )
    await store(replacedLead, beforeUpgrade(lead.ticket.summary!))

    assert.deepEqual(await refreshReplacedSummaries(demo.database), [
      replacedLead,
    ])
    const summary = (await detail(replacedLead)).ticket.summary!
    assert.equal(summary.status, 'blocked')
    assert.deepEqual(summary.issues, ['Task docs: failed'])
    assert.match(summary.happened, /1 failed · 1 replaced/)
    assert.equal((await listed(replacedLead)).summary!.status, 'blocked')
  })

  test('a lead whose ended task was never retried is not touched', async () => {
    const { replacedLead } = demo.tickets
    await demo.database.query(
      `UPDATE tasks SET key = 'export-other'
       WHERE key = 'export-fix-2'
         AND ticket_id = (SELECT id FROM tickets WHERE number = $1)`,
      [replacedLead],
    )
    const lead = await detail(replacedLead)
    await store(replacedLead, beforeUpgrade(lead.ticket.summary!))
    const before = (await detail(replacedLead)).ticket
    assert.deepEqual(await refreshReplacedSummaries(demo.database), [])
    const after = (await detail(replacedLead)).ticket
    assert.equal(after.summary!.status, 'blocked')
    assert.deepEqual(after.summary, before.summary)
    assert.equal(after.summaryAt, before.summaryAt)
  })
})
