import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createApp } from '../src/api/app.ts'
import type { TicketResponse } from '../src/api/contract.ts'
import { listenForEvents } from '../src/store/events.ts'
import {
  createRepository,
  markRepositoryReady,
} from '../src/store/repositories.ts'
import { listTasks, parkForTasks, startTask } from '../src/store/tasks.ts'
import {
  addAttemptUsage,
  claimAttempts,
  completeAttempt,
  createTicket,
  markRunning,
} from '../src/store/tickets.ts'
import type { Database } from '../src/store/database.ts'
import {
  builtInWorkflow,
  createTestStore,
  testLibrary,
} from './helpers/store.ts'

async function runStep(
  database: Database,
  ticketId: number,
  executor: string,
  result?: Parameters<typeof completeAttempt>[2],
) {
  const claimed = (await claimAttempts(database, 100)).find(
    (item) => item.ticket.id === ticketId,
  )!
  await markRunning(database, claimed.attempt.id, executor)
  if (result) await completeAttempt(database, claimed.attempt.id, result)
  return claimed.attempt.id
}

test('tokens saved on attempts reach the ticket response, and a lead totals its child tasks', async (t) => {
  const store = await createTestStore()
  const events = listenForEvents(store.database)
  await events.ready
  const home = await mkdtemp(join(tmpdir(), 'ksf-usage-'))
  t.after(async () => {
    await events.close()
    await store.close()
    await rm(home, { recursive: true, force: true })
  })
  const { database } = store
  const app = createApp({
    database,
    library: await testLibrary(),
    events,
    home,
  })
  const ticketResponse = async (number: number) => {
    const response = await app.request(`/api/tickets/${number}`)
    assert.equal(response.status, 200)
    return (await response.json()) as TicketResponse
  }
  const repository = await createRepository(database, { slug: 'acme/usage' })
  await markRepositoryReady(database, repository.id, {
    capabilities: ['verify'],
  })

  const lead = await createTicket(database, {
    repository: repository.slug,
    workflow: await builtInWorkflow('lead'),
    title: 'Build the export feature',
  })
  const leadRun = await runStep(database, lead.id, 'codex')
  // Two sessions of one attempt (a retried result) add up.
  await addAttemptUsage(database, leadRun, {
    inputTokens: 1_000_000,
    outputTokens: 150_000,
  })
  await addAttemptUsage(database, leadRun, {
    inputTokens: 234_567,
    outputTokens: 30_000,
  })
  await completeAttempt(database, leadRun, {
    outcome: 'delegate',
    summary: 'Split the work',
    artifacts: [],
    tasks: [
      { key: 'api', title: 'Add the endpoint', instructions: 'Add it.' },
      { key: 'docs', title: 'Document it', instructions: 'Describe it.' },
      { key: 'later', title: 'Not started', instructions: 'Later.' },
    ],
  })
  const parked = await runStep(database, lead.id, 'system')
  await parkForTasks(database, parked)
  const [api, docs] = await listTasks(database, lead.id)
  const children = []
  for (const task of [api!, docs!])
    children.push(
      (await startTask(
        database,
        task.id,
        {
          repository: repository.slug,
          workflow: await builtInWorkflow('task'),
          title: task.title,
          body: task.instructions,
        },
        null,
      ))!,
    )
  const [apiChild, docsChild] = children
  const build = await runStep(database, apiChild!.id, 'codex')
  await addAttemptUsage(database, build, {
    inputTokens: 35_700,
    outputTokens: 950,
  })
  await completeAttempt(database, build, {
    outcome: 'done',
    summary: 'Added the endpoint',
    artifacts: [],
  })
  // A running attempt's tokens are not counted until it finishes.
  const testing = await runStep(database, apiChild!.id, 'codex')
  await addAttemptUsage(database, testing, {
    inputTokens: 9,
    outputTokens: 9,
  })

  const child = await ticketResponse(apiChild!.number)
  const [builtAttempt, testAttempt] = child.attempts
  assert.equal(builtAttempt!.inputTokens, 35_700)
  assert.equal(builtAttempt!.outputTokens, 950)
  assert.equal(testAttempt!.inputTokens, 9)
  assert.equal(testAttempt!.finishedAt, null)
  assert.equal(child.usage!.total.inputTokens, 35_700)
  assert.equal(child.usage!.total.outputTokens, 950)
  assert.equal(child.usage!.total.steps, 1)
  assert.deepEqual(child.usage!.tasks, [])

  const response = await ticketResponse(lead.number)
  const [leadAttempt, runTasks] = response.attempts
  assert.equal(leadAttempt!.inputTokens, 1_234_567)
  assert.equal(leadAttempt!.outputTokens, 180_000)
  // The system step that runs the tasks never reports tokens.
  assert.equal(runTasks!.inputTokens, null)
  assert.equal(runTasks!.outputTokens, null)
  assert.deepEqual(
    response.usage!.tasks.map((task) => ({
      ...task,
      usage: { ...task.usage, durationMs: typeof task.usage.durationMs },
    })),
    [
      {
        taskId: api!.id,
        key: 'api',
        title: 'Add the endpoint',
        status: 'running',
        ticketNumber: apiChild!.number,
        usage: {
          inputTokens: 35_700,
          outputTokens: 950,
          durationMs: 'number',
          steps: 1,
        },
      },
      {
        taskId: docs!.id,
        key: 'docs',
        title: 'Document it',
        status: 'running',
        ticketNumber: docsChild!.number,
        usage: {
          inputTokens: null,
          outputTokens: null,
          durationMs: 'number',
          steps: 0,
        },
      },
    ],
  )
  assert.equal(response.usage!.total.inputTokens, 1_234_567 + 35_700)
  assert.equal(response.usage!.total.outputTokens, 180_000 + 950)
  assert.equal(response.usage!.total.steps, 2)
  assert.equal(
    response.usage!.total.durationMs,
    child.usage!.total.durationMs +
      Date.parse(leadAttempt!.finishedAt!) -
      Date.parse(leadAttempt!.startedAt!),
  )
})
