import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { createApp } from '../src/api/app.ts'
import type {
  ErrorResponse,
  TicketResponse,
  TicketsResponse,
} from '../src/api/contract.ts'
import {
  DEFAULT_SETTINGS,
  resolveAgent,
  type TicketAgents,
} from '../src/domain/settings.ts'
import { agentFor, agentsFor } from '../src/engine/tasks.ts'
import { openDatabase } from '../src/store/database.ts'
import { listenForEvents } from '../src/store/events.ts'
import { saveSettings } from '../src/store/settings.ts'
import { claimAttempts, createTicket, getTicket } from '../src/store/tickets.ts'
import { proofContext } from './fixtures/proof-agent.ts'
import {
  build,
  deferred,
  leadFixture,
  leadState,
  result,
  until,
} from './helpers/lead.ts'
import { builtInWorkflow } from './helpers/store.ts'

const fallback = { cli: 'codex', model: 'fallback' } as const
const ticketDefault = { cli: 'codex', model: 'ticket-default' } as const
const builder = {
  cli: 'codex',
  model: 'ticket-builder',
  effort: 'high',
} as const
const checker = { cli: 'claude', model: 'ticket-checker' } as const
const delegated = { cli: 'claude', model: 'delegated-builder' } as const
const reviewers = [
  { cli: 'codex', model: 'ticket-reviewer', effort: 'high' },
  { cli: 'claude', model: 'ticket-reviewer', effort: 'medium' },
] as const

test('ticket role, delegated builder, ticket default, workflow role, global role and default resolve in order', () => {
  const global = { cli: 'claude', model: 'global-builder' } as const
  const workflow = { cli: 'codex', model: 'workflow-builder' } as const
  const settings = {
    ...DEFAULT_SETTINGS,
    agents: {
      ...DEFAULT_SETTINGS.agents,
      default: fallback,
      roles: { builder: global },
    },
    workflows: { task: { roles: { builder: workflow } } },
  }
  const at = { workflow: 'task', role: 'builder' } as const
  assert.deepEqual(resolveAgent(settings, at), workflow)
  assert.deepEqual(resolveAgent(settings, { ...at, workflow: 'other' }), global)
  assert.deepEqual(resolveAgent(settings, { ...at, role: 'lead' }), fallback)
  const defaults = { default: ticketDefault }
  assert.deepEqual(
    resolveAgent(settings, { ...at, ticketAgents: defaults }),
    ticketDefault,
  )
  assert.deepEqual(
    resolveAgent(settings, {
      ...at,
      ticketAgents: defaults,
      taskAgent: delegated,
    }),
    delegated,
  )
  const ticketAgents = { ...defaults, roles: { builder } }
  assert.deepEqual(
    resolveAgent(settings, { ...at, ticketAgents, taskAgent: delegated }),
    builder,
  )
  for (const role of [
    'lead',
    'planner',
    'tester',
    'reviewer',
    'writer',
    'reproducer',
    'onboarder',
  ] as const)
    assert.deepEqual(
      resolveAgent(settings, {
        ...at,
        role,
        ticketAgents,
        taskAgent: delegated,
      }),
      ticketDefault,
    )
})

test('ticket API validates, returns and persists only supplied choices without changing Settings', async (t) => {
  const f = await leadFixture()
  const events = listenForEvents(f.database)
  await events.ready
  t.after(async () => {
    await events.close()
    await f.close()
  })
  const app = () =>
    createApp({
      database: f.database,
      library: f.library,
      events,
      home: f.home,
    })
  const post = (agents?: unknown) =>
    app().request('/api/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repository: f.repository.slug,
        workflow: 'lead',
        title: 'Configured ticket',
        ...(agents === undefined ? {} : { agents }),
      }),
    })
  const before = await (await app().request('/api/settings')).json()
  for (const [agents, issue] of [
    [null, /agents/],
    [{ default: { cli: 'unknown' } }, /agents\.default\.cli/],
    [{ roles: { designer: fallback } }, /agents\.roles/],
    [
      { roles: { lead: { cli: 'codex', model: ' ' } } },
      /agents\.roles\.lead\.model/,
    ],
    [
      { reviewers: [{ cli: 'claude', effort: 'huge' }] },
      /agents\.reviewers\.0\.effort/,
    ],
    [{ allowed: [fallback] }, /agents.*allowed/],
    [{ reviewers: 'claude' }, /agents\.reviewers/],
    [{ default: { cli: 'codex', extra: true } }, /agents\.default.*extra/],
  ] as const) {
    const response = await post(agents)
    assert.equal(response.status, 400)
    const error = (await response.json()) as ErrorResponse
    assert.match(error.issues!.join('; '), issue)
  }
  assert.deepEqual(
    ((await (await app().request('/api/tickets')).json()) as TicketsResponse)
      .tickets,
    [],
  )
  const choices: TicketAgents = {
    roles: { lead: { ...ticketDefault, model: ' ticket-default ' } },
    reviewers: [],
  }
  const response = await post(choices)
  assert.equal(response.status, 201)
  const created = (await response.json()) as TicketResponse
  const stored = { roles: { lead: ticketDefault }, reviewers: [] }
  assert.deepEqual(created.ticket.agents, stored)
  const reopened = openDatabase(f.store.url)
  try {
    assert.deepEqual(
      (await getTicket(reopened, created.ticket.number))!.agents,
      stored,
    )
    const resumed = createApp({
      database: reopened,
      library: f.library,
      events,
      home: f.home,
    })
    const detail = (await (
      await resumed.request(`/api/tickets/${created.ticket.number}`)
    ).json()) as TicketResponse
    assert.deepEqual(detail.ticket.agents, stored)
    const list = (await (
      await resumed.request('/api/tickets')
    ).json()) as TicketsResponse
    assert.deepEqual(list.tickets[0]!.agents, stored)
  } finally {
    await reopened.end()
  }
  const plain = (await (await post()).json()) as TicketResponse
  assert.equal(plain.ticket.agents, null)
  const empty = (await (await post({})).json()) as TicketResponse
  assert.deepEqual(empty.ticket.agents, {})
  assert.deepEqual(await (await app().request('/api/settings')).json(), before)
  const changed = {
    ...DEFAULT_SETTINGS,
    agents: { ...DEFAULT_SETTINGS.agents, default: checker },
    workflows: { lead: { roles: { lead: delegated } } },
  }
  await saveSettings(f.database, changed)
  const context = {
    ticket: created.ticket,
    workflow: f.library.get('lead')!.workflow,
  }
  const options = { database: f.database, config: { ...f.config, ...changed } }
  assert.deepEqual(await agentFor(options, context, 'lead'), ticketDefault)
  assert.deepEqual(await agentFor(options, context, 'writer'), checker)
})

test('ticket reviewer lists override workflow and global lists; empty disables parallel review and independence still applies', async (t) => {
  const f = await leadFixture()
  t.after(() => f.close())
  const workflowReviewers = [
    { cli: 'claude', model: 'workflow-reviewer' },
  ] as const
  const globalReviewers = [{ cli: 'codex', model: 'global-reviewer' }] as const
  const config = {
    ...f.config,
    agents: {
      ...f.config.agents,
      default: fallback,
      reviewers: [...globalReviewers],
    },
    workflows: {
      lead: { roles: { reviewer: checker }, reviewers: [...workflowReviewers] },
    },
  }
  const options = { database: f.database, config }
  const select = async (agents?: TicketAgents) => {
    const ticket = await createTicket(f.database, {
      repository: f.repository.slug,
      workflow: f.library.get('lead')!,
      title: 'Select reviewers',
      ...(agents === undefined ? {} : { agents }),
    })
    return { ticket, workflow: f.library.get('lead')!.workflow }
  }
  assert.deepEqual(
    (await agentsFor(options, await select(), 'reviewer')).agents,
    workflowReviewers,
  )
  assert.deepEqual(
    (
      await agentsFor(
        { ...options, config: { ...config, workflows: {} } },
        await select(),
        'reviewer',
      )
    ).agents,
    globalReviewers,
  )
  const context = await select({
    default: ticketDefault,
    roles: { reviewer: checker },
    reviewers: [...reviewers],
  })
  assert.deepEqual(
    (await agentsFor(options, context, 'reviewer')).agents,
    reviewers,
  )
  assert.deepEqual(
    (
      await agentsFor(
        options,
        await select({ roles: { reviewer: checker }, reviewers: [] }),
        'reviewer',
      )
    ).agents,
    [checker],
  )
  const replaced = await agentsFor(
    options,
    await select({
      roles: { builder, reviewer: builder, tester: builder },
      reviewers: [builder, checker],
    }),
    'reviewer',
  )
  assert.deepEqual(replaced.agents, [checker, checker])
  assert.match(replaced.notes[0]!.title, /replaced for independence/)
  const tester = await agentsFor(
    options,
    await select({ roles: { builder, tester: builder }, default: checker }),
    'tester',
  )
  assert.deepEqual(tester.agents, [checker])
  const same = {
    ...options,
    config: { ...f.config, agents: { ...f.config.agents, default: builder } },
  }
  const notIndependent = await agentsFor(
    same,
    await select({ default: builder, reviewers: [builder] }),
    'reviewer',
  )
  assert.deepEqual(notIndependent.agents, [builder])
  assert.equal(notIndependent.notes[0]!.title, 'Review was not independent')
  const recorded = { cli: 'claude', model: 'recorded-selection' } as const
  const [attempt] = await claimAttempts(f.database, 1)
  assert.ok(attempt)
  assert.deepEqual(
    await agentFor(
      options,
      { ...attempt, attempt: { ...attempt.attempt, agent: recorded } },
      'lead',
    ),
    recorded,
  )
})

test('lead overrides survive restart and Settings changes, reach child proof and writers, and select parallel final reviewers', async (t) => {
  const f = await leadFixture(
    {
      agents: {
        default: fallback,
        allowed: [delegated],
        reviewers: [{ cli: 'codex', model: 'global-reviewer' }],
      },
    },
    'missing',
  )
  t.after(() => f.close())
  const choices: TicketAgents = {
    default: ticketDefault,
    roles: { builder, tester: checker, reviewer: checker },
    reviewers: [...reviewers],
  }
  let pauseBuilders = true
  const hold = deferred()
  const finalReviewers = deferred()
  let finalReviews = 0
  f.setBehaviour(async (role, invocation, title) => {
    if (role === 'lead') {
      const { tasks } = leadState(invocation.prompt)
      if (!tasks.length)
        return result(invocation.directory, {
          outcome: 'delegate',
          summary: 'Two tasks',
          artifacts: [],
          tasks: [
            {
              key: 'branch',
              title: 'Branch change',
              instructions: 'Write branch.txt',
              agent: delegated,
            },
            {
              key: 'pr',
              title: 'PR change',
              instructions: 'Write pr.txt',
              land: 'pr',
              agent: delegated,
            },
          ],
        })
      return result(invocation.directory, {
        outcome: tasks.every((task) =>
          ['merged', 'left-open', 'pr-ready'].includes(task.status),
        )
          ? 'done'
          : 'delegate',
        summary: 'Task progress',
        artifacts: [],
        pullRequests: tasks
          .filter((task) => task.status === 'pr-ready')
          .map((task) => ({ task: task.key, decision: 'leave-open' })),
      })
    }
    if (role === 'builder') {
      if (pauseBuilders) await hold.wait(invocation.signal)
      return build(
        invocation,
        title === 'Branch change' ? 'branch.txt' : 'pr.txt',
        title,
      )
    }
    if (role === 'reviewer') {
      if (title === 'Lead the change') {
        if (++finalReviews === 2) finalReviewers.release()
        await finalReviewers.wait(invocation.signal)
      }
      return result(invocation.directory, {
        outcome: 'passed',
        summary: 'Reviewed',
        artifacts: [],
      })
    }
    assert.equal(role, 'tester')
    const instance = proofContext(invocation.prompt).instances[0]!
    const path = join(instance.evidenceDir, 'observed.txt')
    await writeFile(
      path,
      await readFile(
        join(
          instance.checkout,
          title === 'PR change' ? 'pr.txt' : 'branch.txt',
        ),
        'utf8',
      ),
    )
    return result(invocation.directory, {
      outcome: 'passed',
      summary: 'Checked',
      artifacts: [
        {
          kind: 'evidence',
          title: 'Change',
          path,
          scenario: 'Change',
          scenarioResult: 'passed',
        },
      ],
    })
  })
  const lead = await createTicket(f.database, {
    repository: f.repository.slug,
    workflow: await builtInWorkflow('lead'),
    title: 'Lead the change',
    agents: choices,
  })
  await f.start()
  await until(
    async () => f.invocations.filter((item) => item.role === 'builder'),
    (items) => items.length === 2,
  )
  await f.stop()
  await saveSettings(f.database, {
    ...DEFAULT_SETTINGS,
    concurrency: 3,
    agents: {
      ...DEFAULT_SETTINGS.agents,
      default: delegated,
      allowed: [delegated],
      reviewers: [delegated],
    },
    workflows: {
      lead: { roles: { lead: delegated }, reviewers: [delegated] },
      task: { roles: { builder: delegated, tester: delegated } },
      'task-pr': {
        roles: { builder: delegated, reviewer: delegated, writer: delegated },
      },
    },
  })
  pauseBuilders = false
  await f.start()
  const done = await until(
    async () => {
      const detail = await f.detail(lead.number)
      if (detail.ticket.waiting?.for === 'ask')
        assert.fail(detail.ticket.waiting.summary ?? 'Lead stopped')
      return detail
    },
    (detail) => detail.ticket.waiting?.for === 'pull-request-merge',
  )
  assert.deepEqual(done.ticket.agents, choices)
  for (const task of done.tasks) {
    const child = await f.detail(task.child!.number)
    assert.deepEqual(child.ticket.agents, choices)
    assert.deepEqual(task.agent, delegated)
    assert.ok(
      child.attempts.some((attempt) => attempt.status === 'interrupted'),
    )
    assert.deepEqual(
      child.attempts
        .filter((attempt) => attempt.stepId === 'build')
        .map((attempt) => attempt.agent),
      [builder, builder],
    )
  }
  for (const invocation of f.invocations) {
    const expected =
      invocation.role === 'builder'
        ? builder
        : invocation.role === 'tester'
          ? checker
          : invocation.role === 'reviewer'
            ? invocation.title === 'Lead the change'
              ? reviewers.find((agent) => agent.cli === invocation.config.cli)!
              : checker
            : ticketDefault
    assert.deepEqual(invocation.config, expected)
  }
  assert.equal(finalReviews, 2)
  assert.ok(
    f.invocations.some(
      (item) => item.role === 'writer' && item.title === 'PR change',
    ),
  )
  assert.ok(
    f.invocations.some(
      (item) => item.role === 'writer' && item.title === 'Lead the change',
    ),
  )
  assert.deepEqual(f.errors, [])
})
