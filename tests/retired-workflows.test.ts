import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import type {
  SettingsResponse,
  TicketResponse,
  WorkflowsResponse,
} from '../src/api/contract.ts'
import {
  DEFAULT_SETTINGS,
  resolveAgent,
  stepTimeoutFor,
} from '../src/domain/settings.ts'
import { parseUpload } from '../src/library/library.ts'
import { startFactory } from '../src/server.ts'
import {
  createRepository,
  markRepositoryReady,
} from '../src/store/repositories.ts'
import {
  claimAttempts,
  completeAttempt,
  createTicket,
  markRunning,
} from '../src/store/tickets.ts'
import { createTestStore } from './helpers/store.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { once } from 'node:events'

test('retired workflow tickets survive startup, serve history, route stored steps and retain settings', async (t) => {
  const store = await createTestStore()
  const home = await mkdtemp(join(tmpdir(), 'retired-workflows-'))
  let factory: Awaited<ReturnType<typeof startFactory>> | undefined
  t.after(async () => {
    await factory?.close()
    await store.close()
    await rm(home, { recursive: true, force: true })
  })
  const repository = await createRepository(store.database, {
    slug: 'fixture/legacy',
  })
  await markRepositoryReady(store.database, repository.id, {
    capabilities: ['verify'],
  })
  const numbers: number[] = []
  for (const [name, fixture] of [
    ['quick-change', 'planned-change'],
    ['feature', 'tested-change'],
  ] as const) {
    const source = (
      await readFile(
        new URL(`./fixtures/workflows/${fixture}.yml`, import.meta.url),
        'utf8',
      )
    ).replace(`name: ${fixture}`, `name: ${name}`)
    const entry = parseUpload(source)
    if (!entry.ok) assert.fail(entry.errors.join('\n'))
    const ticket = await createTicket(store.database, {
      repository: repository.slug,
      workflow: entry.entry,
      title: `Stored ${name}`,
    })
    const [context] = await claimAttempts(store.database, 1)
    assert.ok(context)
    await markRunning(store.database, context.attempt.id, 'fixture')
    await completeAttempt(store.database, context.attempt.id, {
      outcome: 'done',
      summary: 'Historical plan ready',
      artifacts: [
        {
          kind: 'plan',
          title: 'Historical plan',
          content: 'Keep this history readable.',
        },
      ],
    })
    numbers.push(ticket.number)
  }
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const address = reservation.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  factory = await startFactory({
    databaseUrl: store.url,
    home,
    port: address.port,
    scheduler: false,
  })
  const response = await fetch(`${factory.url}/api/workflows`)
  assert.equal(response.status, 200)
  const { workflows } = (await response.json()) as WorkflowsResponse
  assert.deepEqual(
    workflows
      .filter((workflow) => workflow.selectable)
      .map((workflow) => workflow.name),
    ['bug', 'lead', 'onboard-repo'],
  )
  assert.deepEqual(
    workflows
      .filter((workflow) => !workflow.selectable)
      .map((workflow) => workflow.name)
      .sort(),
    ['task', 'task-pr'],
  )
  for (const [index, number] of numbers.entries()) {
    const ticketResponse = await fetch(`${factory.url}/api/tickets/${number}`)
    assert.equal(ticketResponse.status, 200)
    const detail = (await ticketResponse.json()) as TicketResponse
    assert.equal(detail.workflow.name, index === 0 ? 'quick-change' : 'feature')
    assert.equal(detail.ticket.currentStep, 'approve-plan')
    assert.equal(detail.attempts[0]?.summary, 'Historical plan ready')
    assert.equal(detail.artifacts[0]?.content, 'Keep this history readable.')
    assert.ok(detail.events.some((event) => event.kind === 'attempt.finished'))
    const decision = await fetch(
      `${factory.url}/api/tickets/${number}/decision`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attemptId: detail.ticket.waiting!.attemptId,
          choice: 'approved',
        }),
      },
    )
    assert.equal(decision.status, 200)
    assert.equal(
      ((await decision.json()) as TicketResponse).ticket.currentStep,
      'build',
    )
  }
  const settings = {
    ...DEFAULT_SETTINGS,
    workflows: {
      'quick-change': {
        stepTimeoutMinutes: 42,
        roles: { builder: { cli: 'claude' as const } },
      },
    },
  }
  const saved = await fetch(`${factory.url}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  })
  assert.equal(saved.status, 200)
  const value = (await saved.json()) as SettingsResponse
  assert.ok(value.workflows.includes('quick-change'))
  assert.deepEqual(value.settings, settings)
  assert.equal(stepTimeoutFor(value.settings, 'quick-change'), 42)
  assert.deepEqual(
    resolveAgent(value.settings, { workflow: 'quick-change', role: 'builder' }),
    { cli: 'claude' },
  )
  const claimed = await claimAttempts(store.database, 2)
  assert.deepEqual(
    claimed.map((context) => context.step.id),
    ['build', 'build'],
  )
})
