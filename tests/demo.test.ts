import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { seedDemo } from '../scripts/demo-data.ts'
import { listRepositories } from '../src/store/repositories.ts'
import { getTicketDetail, listTickets } from '../src/store/tickets.ts'
import { createDemoStore } from './helpers/demo.ts'
import { builtInLibrary } from './helpers/store.ts'

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
      [tickets.waitingForMerge, 'needs-you', 'pull-request-merge'],
      [tickets.done, 'done', null],
      [tickets.cancelled, 'cancelled', null],
    ] as const
    for (const [number, status, waitingFor] of expected) {
      const { ticket } = await detail(number)
      assert.equal(ticket.status, status, `#${number}`)
      assert.equal(ticket.waiting?.for ?? null, waitingFor, `#${number}`)
    }
    assert.equal((await listTickets(demo.database)).length, 7)
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

  test('the running and merge-waiting tickets look real', async () => {
    const running = await detail(demo.tickets.running)
    assert.equal(running.attempts.at(-1)?.executor, 'claude-code')
    const merge = await detail(demo.tickets.waitingForMerge)
    assert.match(merge.ticket.pullRequestUrl ?? '', /\/pull\/42$/)
  })

  test('refuses to seed twice', async () => {
    await assert.rejects(
      seedDemo(demo.database, await builtInLibrary()),
      /already has demo data/,
    )
  })
})
