import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { seedDemo } from '../scripts/demo-data.ts'
import {
  createRepository,
  listRepositories,
} from '../src/store/repositories.ts'
import { getTicketDetail, listTickets } from '../src/store/tickets.ts'
import { createDemoStore } from './helpers/demo.ts'
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
      [tickets.waitingForMerge, 'needs-you', 'pull-request-merge'],
      [tickets.done, 'done', null],
      [tickets.cancelled, 'cancelled', null],
    ] as const
    for (const [number, status, waitingFor] of expected) {
      const { ticket } = await detail(number)
      assert.equal(ticket.status, status, `#${number}`)
      assert.equal(ticket.waiting?.for ?? null, waitingFor, `#${number}`)
    }
    assert.equal((await listTickets(demo.database)).length, 9)
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
        10_000,
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
    assert.equal(proof.ticket.workflow.name, 'feature')
    const verdict = proof.attempts.find(
      (a) => a.stepId === 'test' && a.outcome === 'passed',
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
