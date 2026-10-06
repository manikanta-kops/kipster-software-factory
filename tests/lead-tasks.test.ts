import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pollAutoMerge } from '../src/engine/auto-merge.ts'
import { run } from '../src/executors/process.ts'
import { cancelTicket, createTicket } from '../src/store/tickets.ts'
import { autoMergeFixture } from './helpers/auto-merge.ts'
import {
  build,
  deferred,
  leadFixture,
  leadState,
  result,
  until,
} from './helpers/lead.ts'
import { saveSettings } from '../src/store/settings.ts'

test('a lead runs branch tasks in parallel, hears each finish while others run, and its branch gets all the work', async (t) => {
  const f = await leadFixture()
  t.after(() => f.close())
  const beta = deferred()
  f.setBehaviour(async (role, invocation, title) => {
    if (role === 'lead') {
      const { tasks } = leadState(invocation.prompt)
      if (tasks.length === 0)
        return result(invocation.directory, {
          outcome: 'delegate',
          summary: 'Three independent files',
          artifacts: [],
          tasks: ['Alpha', 'Beta', 'Gamma'].map((name) => ({
            key: name.toLowerCase(),
            title: name,
            instructions: `Write ${name.toLowerCase()}.txt`,
          })),
        })
      return result(invocation.directory, {
        outcome: tasks.every((task) => task.status === 'merged')
          ? 'done'
          : 'delegate',
        summary: 'Checked the tasks',
        artifacts: [],
      })
    }
    if (role === 'builder') {
      if (title === 'Beta') await beta.wait(invocation.signal)
      return build(invocation, `${title.toLowerCase()}.txt`, `${title}\n`)
    }
    return result(invocation.directory, {
      outcome: 'passed',
      summary: 'Looks right',
      artifacts: [],
    })
  })
  const lead = await f.lead()
  await f.start()

  const heard = await until(
    async () =>
      f.invocations
        .filter((item) => item.role === 'lead')
        .map((item) => leadState(item.prompt).tasks),
    (runs) =>
      runs.some(
        (tasks) =>
          tasks.find((task) => task.key === 'alpha')?.status === 'merged' &&
          tasks.find((task) => task.key === 'beta')?.status === 'running',
      ),
  )
  assert.ok(heard.length >= 2)
  const parked = await f.detail(lead.number)
  assert.equal(
    parked.tasks.find((task) => task.key === 'beta')!.status,
    'running',
  )
  beta.release()

  const done = await until(
    () => f.detail(lead.number),
    (detail) => detail.ticket.currentStep === 'confirm',
  )
  assert.deepEqual(
    done.tasks.map((task) => [task.key, task.status]),
    [
      ['alpha', 'merged'],
      ['beta', 'merged'],
      ['gamma', 'merged'],
    ],
  )
  for (const task of done.tasks)
    assert.match(
      task.result!,
      /^Merged into the lead branch at [0-9a-f]{40}\.$/,
    )
  assert.deepEqual(await f.files(done.ticket.branch), [
    'README.md',
    'alpha.txt',
    'beta.txt',
    'gamma.txt',
  ])
  // Gamma waited for a free slot, so it started from a lead branch that already had alpha.
  const gamma = done.tasks.find((task) => task.key === 'gamma')!
  assert.ok((await f.files(gamma.baseCommit!)).includes('alpha.txt'))
  const child = await f.detail(gamma.child!.number)
  assert.equal(child.parentTask?.parent.number, lead.number)
  assert.equal(child.parentTask?.key, 'gamma')
  assert.match(child.ticket.body, /^Write gamma\.txt/)
  const builder = f.invocations.find(
    (item) => item.role === 'builder' && item.title === 'Gamma',
  )!
  assert.match(builder.prompt, /This ticket is task "gamma" of lead ticket/)
  // Tasks that finish within one poll share a report, so count reported merges, not notes.
  assert.ok(
    done.artifacts.filter((artifact) => artifact.title === 'Task report')
      .length >= 2,
  )
  const reports = done.attempts.filter(
    (attempt) => attempt.stepId === 'run' && attempt.outcome === 'reported',
  )
  for (const key of ['alpha', 'beta', 'gamma'])
    assert.ok(
      reports.some((attempt) =>
        new RegExp(`\\b${key} merged\\b`).test(attempt.summary!),
      ),
      `${key} merge was reported`,
    )
  assert.ok(
    f.invocations
      .filter((item) => item.role === 'lead')
      .at(-1)!
      .prompt.includes('Task report'),
  )
  assert.equal(done.ticket.status, 'needs-you')
  assert.deepEqual(f.errors, [])
})

test('failed and conflicting tasks reach the lead, and done is refused while tasks still run', async (t) => {
  const f = await leadFixture()
  t.after(() => f.close())
  let refused = false
  f.setBehaviour(async (role, invocation, title) => {
    if (role === 'lead') {
      const { tasks } = leadState(invocation.prompt)
      if (tasks.length === 0)
        return result(invocation.directory, {
          outcome: 'delegate',
          summary: 'Two edits to one file, and one more',
          artifacts: [],
          tasks: [
            { key: 'x', title: 'X', instructions: 'Write shared.txt as x' },
            { key: 'y', title: 'Y', instructions: 'Write shared.txt as y' },
            { key: 'z', title: 'Zed', instructions: 'Write z.txt' },
          ],
        })
      const open = tasks.some((task) =>
        ['pending', 'running'].includes(task.status),
      )
      if (open && !refused) {
        refused = true
        return result(invocation.directory, {
          outcome: 'done',
          summary: 'Claiming done too early',
          artifacts: [],
        })
      }
      return result(invocation.directory, {
        outcome: open ? 'delegate' : 'done',
        summary: 'Checked the tasks',
        artifacts: [],
      })
    }
    if (role === 'builder')
      return title === 'Zed'
        ? build(invocation, 'z.txt', 'z\n')
        : build(invocation, 'shared.txt', `${title}\n`)
    return title === 'Zed'
      ? result(invocation.directory, {
          outcome: 'changes-needed',
          summary: 'z.txt has the wrong content',
          artifacts: [
            { kind: 'finding', title: 'Wrong content', content: 'Fix z.txt' },
          ],
        })
      : result(invocation.directory, {
          outcome: 'passed',
          summary: 'Fine',
          artifacts: [],
        })
  })
  const lead = await f.lead()
  await f.start()
  const done = await until(
    () => f.detail(lead.number),
    (detail) => detail.ticket.currentStep === 'confirm',
  )
  const status = new Map(done.tasks.map((task) => [task.key, task]))
  assert.deepEqual([status.get('x')!.status, status.get('y')!.status].sort(), [
    'conflict',
    'merged',
  ])
  const conflict = done.tasks.find((task) => task.status === 'conflict')!
  assert.match(conflict.result!, /Files: shared\.txt/)
  assert.match(conflict.result!, new RegExp(conflict.child!.branch))
  assert.equal(status.get('z')!.status, 'failed')
  assert.match(
    status.get('z')!.result!,
    /cancelled after review: z\.txt has the wrong content/,
  )
  assert.equal(
    (await f.detail(status.get('z')!.child!.number)).ticket.status,
    'cancelled',
  )
  const retry = f.invocations.find(
    (item) =>
      item.role === 'lead' &&
      item.prompt.includes('Previous result validation failed'),
  )
  assert.ok(retry, 'the early done gets one fresh retry')
  assert.match(retry.prompt, /done needs every task finished/)
  // The lead branch keeps whichever edit merged first and is clean.
  const files = await f.files(done.ticket.branch)
  assert.ok(files.includes('shared.txt'))
  assert.equal(
    await run('git', ['status', '--porcelain'], {
      cwd: f.workspaces.path(done.ticket),
    }),
    '',
  )
  assert.deepEqual(f.errors, [])
})

test('pull request tasks wait for the lead: merge goes through the merge step, leave-open stays for the owner', async (t) => {
  const f = await leadFixture()
  t.after(() => f.close())
  f.setBehaviour(async (role, invocation, title) => {
    if (role === 'lead') {
      const { tasks } = leadState(invocation.prompt)
      if (tasks.length === 0)
        return result(invocation.directory, {
          outcome: 'delegate',
          summary: 'Two separate pull requests',
          artifacts: [],
          tasks: [
            {
              key: 'keep',
              title: 'Keep',
              instructions: 'Write keep.txt',
              land: 'pr',
            },
            {
              key: 'park',
              title: 'Park',
              instructions: 'Write park.txt',
              land: 'pr',
            },
          ],
        })
      const pullRequests = tasks
        .filter((task) => task.status === 'pr-ready' && !task.decision)
        .map((task) => ({
          task: task.key,
          decision: task.key === 'keep' ? 'merge' : 'leave-open',
        }))
      const finished = tasks.every((task) =>
        ['merged', 'left-open'].includes(task.status),
      )
      return result(invocation.directory, {
        outcome: finished ? 'done' : 'delegate',
        summary: 'Decided what was ready',
        artifacts: [],
        ...(pullRequests.length ? { pullRequests } : {}),
      })
    }
    if (role === 'builder')
      return build(invocation, `${title.toLowerCase()}.txt`, `${title}\n`)
    throw new Error(`No ${role} in pull request tasks`)
  })
  const lead = await f.lead()
  await f.start()
  const decided = await until(
    () => f.detail(lead.number),
    (detail) =>
      detail.tasks.find((task) => task.key === 'keep')?.decision === 'merge' &&
      detail.tasks.find((task) => task.key === 'park')?.status === 'left-open',
  )
  const keep = decided.tasks.find((task) => task.key === 'keep')!
  assert.equal(keep.status, 'pr-ready')
  assert.match(
    keep.result!,
    /Pull request ready for a decision: https:\/\/github\.com\/fixture\/app\/pull\/\d/,
  )
  const child = await f.detail(keep.child!.number)
  assert.equal(child.ticket.waiting?.for, 'pull-request-merge')
  // Auto-merge is off for this repository, so the owner merges; the lead hears about it.
  const pr = f.pullRequests.get(child.ticket.branch)!
  const head = await run('git', ['rev-parse', child.ticket.branch], {
    cwd: f.workspaces.cache(f.repository),
  })
  pr.state = 'MERGED'
  pr.mergeCommit = { oid: head }
  pr.mergedAt = new Date().toISOString()
  const done = await until(
    () => f.detail(lead.number),
    (detail) => detail.ticket.currentStep === 'confirm',
  )
  assert.deepEqual(
    done.tasks.map((task) => [task.key, task.status, task.decision]),
    [
      ['keep', 'merged', 'merge'],
      ['park', 'left-open', 'leave-open'],
    ],
  )
  assert.match(done.tasks[0]!.result!, /^Pull request merged: https:/)
  const parked = await f.detail(done.tasks[1]!.child!.number)
  assert.equal(parked.ticket.waiting?.for, 'pull-request-merge')
  // Pull request tasks start from the default branch, never the lead's branch.
  assert.equal(done.tasks[0]!.baseCommit, null)
  assert.deepEqual(f.errors, [])
})

test('a pull request task merges automatically only after its lead chose merge', async (t) => {
  const f = await autoMergeFixture(t)
  const { rows } = await f.store.database.query<{
    name: string
    version: string
    source: string
    definition: never
  }>('SELECT name, version, source, definition FROM workflow_versions LIMIT 1')
  const entry = rows[0]!
  const lead = await createTicket(f.store.database, {
    repository: f.repository.slug,
    workflow: {
      workflow: entry.definition,
      version: entry.version,
      source: entry.source,
    },
    title: 'Lead',
  })
  const leadAttempt = (
    await f.store.database.query<{ id: number }>(
      'SELECT id FROM attempts WHERE ticket_id = $1',
      [lead.id],
    )
  ).rows[0]!.id
  await f.store.database.query(
    `INSERT INTO tasks (ticket_id, attempt_id, key, title, instructions, land, workflow, status, child_ticket_id)
     VALUES ($1, $2, 'docs', 'Docs', 'Write docs', 'pr', 'task-pr', 'pr-ready', $3)`,
    [lead.id, leadAttempt, f.ticket.id],
  )
  await pollAutoMerge(f.options, await f.context(), f.signal)
  assert.equal(f.merges(), 0)
  await f.store.database.query(
    "UPDATE tasks SET decision = 'leave-open', status = 'left-open'",
  )
  await pollAutoMerge(f.options, await f.context(), f.signal)
  assert.equal(f.merges(), 0)
  await f.store.database.query(
    "UPDATE tasks SET decision = 'merge', status = 'pr-ready'",
  )
  await pollAutoMerge(f.options, await f.context(), f.signal)
  assert.equal(f.merges(), 1)
})

test('tasks use the chosen agent, survive a restart, and stop when the lead is cancelled', async (t) => {
  const opus = { cli: 'claude', model: 'opus', effort: 'high' } as const
  const f = await leadFixture({ agents: { allowed: [opus] } })
  t.after(() => f.close())
  f.setBehaviour(async (role, invocation) => {
    if (role === 'lead') {
      const { tasks, allowedAgents } = leadState(invocation.prompt)
      assert.deepEqual(allowedAgents, [opus])
      return result(invocation.directory, {
        outcome: 'delegate',
        summary: tasks.length ? 'Waiting' : 'One long task',
        artifacts: [],
        ...(tasks.length
          ? {}
          : {
              tasks: [
                {
                  key: 'long',
                  title: 'Long',
                  instructions: 'Takes a while',
                  agent: opus,
                },
              ],
            }),
      })
    }
    await new Promise((_, reject) =>
      invocation.signal.addEventListener('abort', () =>
        reject(invocation.signal.reason),
      ),
    )
  })
  const lead = await f.lead()
  await f.start()
  await until(
    async () => f.invocations.filter((item) => item.role === 'builder'),
    (builders) => builders.length === 1,
  )
  const builder = f.invocations.find((item) => item.role === 'builder')!
  assert.deepEqual(builder.config, opus)
  await f.stop()
  await f.start()
  await until(
    async () => f.invocations.filter((item) => item.role === 'builder'),
    (builders) => builders.length === 2,
  )
  const waiting = await f.detail(lead.number)
  assert.equal(waiting.ticket.waiting?.for, 'tasks')
  assert.equal(waiting.ticket.status, 'running')
  const childNumber = waiting.tasks[0]!.child!.number
  assert.equal(
    (await f.detail(childNumber)).attempts.find(
      (attempt) => attempt.status === 'running',
    )?.executor,
    'claude',
  )
  await cancelTicket(f.store.database, { ticketNumber: lead.number })
  const cancelled = await f.detail(lead.number)
  assert.equal(cancelled.ticket.status, 'cancelled')
  assert.equal(cancelled.tasks[0]!.status, 'cancelled')
  const child = await until(
    () => f.detail(childNumber),
    (detail) => detail.ticket.status === 'cancelled',
  )
  assert.ok(
    child.artifacts.some((artifact) =>
      artifact.content?.includes(`Lead ticket #${lead.number} was cancelled`),
    ),
  )
  assert.deepEqual(f.errors, [])
})

test('a task agent runs only the builder; workflow overrides and the allowed list come from saved settings', async (t) => {
  const sol = { cli: 'codex', model: 'gpt-6.1-sol', effort: 'high' } as const
  const opusMedium = {
    cli: 'claude',
    model: 'claude-opus-5-5',
    effort: 'medium',
  } as const
  const opusHigh = { ...opusMedium, effort: 'high' } as const
  const globalReviewer = { cli: 'codex', model: 'gpt-review' } as const
  // config.json allows nothing; the saved settings add opusHigh.
  const f = await leadFixture({
    agents: { roles: { reviewer: globalReviewer } },
  })
  t.after(() => f.close())
  await saveSettings(f.store.database, {
    concurrency: 3,
    stepTimeoutMinutes: 120,
    agents: {
      default: { cli: 'codex' },
      roles: { reviewer: globalReviewer },
      allowed: [opusHigh],
    },
    workflows: {
      'data-task': {
        stepTimeoutMinutes: 240,
        roles: { builder: sol, reviewer: opusMedium },
      },
    },
  })
  const leadPrompts: string[] = []
  f.setBehaviour(async (role, invocation, title) => {
    if (role === 'lead') {
      leadPrompts.push(invocation.prompt)
      const { tasks, allowedAgents } = leadState(invocation.prompt)
      assert.deepEqual(allowedAgents, [opusHigh])
      if (tasks.length)
        return result(invocation.directory, {
          outcome: tasks.every((task) => task.status === 'merged')
            ? 'done'
            : 'delegate',
          summary: 'Waiting',
          artifacts: [],
        })
      const retry = invocation.prompt.includes(
        'Previous result validation failed',
      )
      return result(invocation.directory, {
        outcome: 'delegate',
        summary: 'Three tasks',
        artifacts: [],
        tasks: retry
          ? [
              {
                key: 'chosen',
                title: 'Chosen',
                instructions: 'Use the chosen agent',
                workflow: 'data-task',
                agent: opusHigh,
              },
              {
                key: 'data',
                title: 'Data',
                instructions: 'Use the workflow settings',
                workflow: 'data-task',
              },
              {
                key: 'plain',
                title: 'Plain',
                instructions: 'Use the global settings',
              },
            ]
          : [
              {
                key: 'other',
                title: 'Other',
                instructions: 'Not an allowed agent',
                agent: { cli: 'claude', model: 'some-other-model' },
              },
            ],
      })
    }
    if (role === 'builder')
      return build(invocation, `${title.toLowerCase()}.txt`, `${title}\n`)
    return result(invocation.directory, {
      outcome: 'passed',
      summary: 'Looks right',
      artifacts: [],
    })
  })
  const lead = await f.lead()
  await f.start()
  await until(
    async () => f.invocations.filter((item) => item.role === 'reviewer'),
    (reviewers) => reviewers.length === 3,
  )
  assert.match(leadPrompts[1]!, /some-other-model.*is not allowed/)
  const agentOf = (role: string, title: string) =>
    f.invocations.find((item) => item.role === role && item.title === title)
      ?.config
  assert.deepEqual(agentOf('lead', 'Lead the change'), { cli: 'codex' })
  assert.deepEqual(agentOf('builder', 'Chosen'), opusHigh)
  assert.deepEqual(agentOf('reviewer', 'Chosen'), opusMedium)
  assert.deepEqual(agentOf('builder', 'Data'), sol)
  assert.deepEqual(agentOf('reviewer', 'Data'), opusMedium)
  assert.deepEqual(agentOf('builder', 'Plain'), { cli: 'codex' })
  assert.deepEqual(agentOf('reviewer', 'Plain'), globalReviewer)
  const chosen = (await f.detail(lead.number)).tasks.find(
    (task) => task.key === 'chosen',
  )
  const child = await f.detail(chosen!.child!.number)
  assert.deepEqual(
    child.attempts.map((attempt) => [attempt.stepId, attempt.agent]),
    [
      ['build', opusHigh],
      ['review', opusMedium],
    ],
  )
})
