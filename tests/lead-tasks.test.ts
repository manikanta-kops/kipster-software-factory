import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { proofContext } from './fixtures/proof-agent.ts'
import { untestedReasons } from '../src/domain/task-testing.ts'
import { getMergeGate } from '../src/store/merge-gates.ts'
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
  packet,
  result,
  until,
} from './helpers/lead.ts'
import { saveSettings } from '../src/store/settings.ts'
import { builtInWorkflow } from './helpers/store.ts'

test('a lead runs branch tasks in parallel, hears each finish while others run, and its branch gets all the work that merges cleanly', async (t) => {
  const f = await leadFixture()
  t.after(() => f.close())
  const y = deferred()
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
            { key: 'gamma', title: 'Gamma', instructions: 'Write gamma.txt' },
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
    if (role === 'builder') {
      if (title === 'Gamma') return build(invocation, 'gamma.txt', 'Gamma\n')
      if (title === 'Y') await y.wait(invocation.signal)
      return build(invocation, 'shared.txt', `${title}\n`)
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
          tasks.find((task) => task.key === 'x')?.status === 'merged' &&
          tasks.find((task) => task.key === 'y')?.status === 'running',
      ),
  )
  assert.ok(heard.length >= 2)
  const parked = await f.detail(lead.number)
  assert.equal(parked.tasks.find((task) => task.key === 'y')!.status, 'running')
  y.release()

  const done = await until(
    () => f.detail(lead.number),
    (detail) => detail.ticket.currentStep === 'confirm',
  )
  // Y was held until X merged, so Y's shared.txt is the one that conflicts.
  assert.deepEqual(
    done.tasks.map((task) => [task.key, task.status]),
    [
      ['x', 'merged'],
      ['y', 'conflict'],
      ['gamma', 'merged'],
    ],
  )
  for (const task of done.tasks.filter((item) => item.status === 'merged'))
    assert.match(
      task.result!,
      /^Merged into the lead branch at [0-9a-f]{40}\. No checker ran\.$/,
    )
  const conflict = done.tasks.find((task) => task.key === 'y')!
  assert.match(conflict.result!, /Files: shared\.txt/)
  assert.match(conflict.result!, new RegExp(conflict.child!.branch))
  assert.deepEqual(await f.files(done.ticket.branch), [
    'README.md',
    'gamma.txt',
    'shared.txt',
  ])
  assert.equal(
    await run('git', ['show', `${done.ticket.branch}:shared.txt`], {
      cwd: f.workspaces.cache(f.repository),
    }),
    'X',
  )
  assert.equal(
    await run('git', ['status', '--porcelain'], {
      cwd: f.workspaces.path(done.ticket),
    }),
    '',
  )
  // Gamma waited for a free slot, so it started from a lead branch that already had X's work.
  const gamma = done.tasks.find((task) => task.key === 'gamma')!
  assert.ok((await f.files(gamma.baseCommit!)).includes('shared.txt'))
  const child = await f.detail(gamma.child!.number)
  assert.equal(child.parentTask?.parent.number, lead.number)
  assert.equal(child.parentTask?.key, 'gamma')
  assert.match(child.ticket.body, /^Write gamma\.txt/)
  const builder = f.invocations.find(
    (item) => item.role === 'builder' && item.title === 'Gamma',
  )!
  assert.match(builder.prompt, /This ticket is task "gamma" of lead ticket/)
  const retry = f.invocations.find(
    (item) =>
      item.role === 'lead' &&
      item.prompt.includes('Previous result validation failed'),
  )
  assert.ok(retry, 'the early done gets one fresh retry')
  assert.match(retry.prompt, /done needs every task finished/)
  // Tasks that finish within one poll share a report, so count reported merges, not notes.
  assert.ok(
    done.artifacts.filter((artifact) => artifact.title === 'Task report')
      .length >= 2,
  )
  const reports = done.attempts.filter(
    (attempt) => attempt.stepId === 'run' && attempt.outcome === 'reported',
  )
  for (const change of ['x merged', 'y conflict', 'gamma merged'])
    assert.ok(
      reports.some((attempt) =>
        new RegExp(`\\b${change}\\b`).test(attempt.summary!),
      ),
      `${change} was reported`,
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

test('repeated failures reach the lead and refuse identical instructions, then accept changed instructions (lights-out)', async (t) => {
  const f = await leadFixture()
  t.after(() => f.close())
  let attemptedRetry = false
  let sawRefusal = false
  f.setBehaviour(async (role, invocation, title) => {
    if (role === 'lead') {
      const { tasks, repeatedFailure } = leadState(invocation.prompt)
      if (!tasks.length) {
        assert.deepEqual(repeatedFailure, [])
        return result(invocation.directory, {
          outcome: 'delegate',
          summary: 'Try two exports',
          artifacts: [],
          tasks: ['a', 'b'].map((key) => ({
            key,
            title: key,
            instructions: 'Run the export',
          })),
        })
      }
      if (tasks.filter((task) => task.status === 'failed').length < 2)
        return result(invocation.directory, {
          outcome: 'delegate',
          summary: 'Waiting for exports',
          artifacts: [],
        })
      assert.equal(repeatedFailure.length, 1)
      assert.equal(repeatedFailure[0]!.count, 2)
      assert.deepEqual(repeatedFailure[0]!.tasks, ['a', 'b'])
      assert.match(repeatedFailure[0]!.signature, /codex crashed/)
      assert.ok(
        packet(invocation.prompt).artifacts.some(
          (artifact) =>
            artifact.title === 'Task report' &&
            /## Repeated failure\n\n- Same error 2 times: a, b\./.test(
              artifact.content,
            ),
        ),
      )
      if (!attemptedRetry) {
        attemptedRetry = true
        return result(invocation.directory, {
          outcome: 'delegate',
          summary: 'Try the same instructions once more',
          artifacts: [],
          tasks: [
            {
              key: 'identical',
              title: 'Identical',
              instructions: '  Run\n the   export ',
            },
          ],
        })
      }
      if (!tasks.some((task) => task.key === 'changed')) {
        assert.match(invocation.prompt, /Previous result validation failed/)
        assert.match(
          invocation.prompt,
          /same instructions already failed 2 times with the same error/,
        )
        assert.match(
          invocation.prompt,
          /classify the cause \(task, plan or factory\), record it as a decision artifact/,
        )
        sawRefusal = true
        return result(invocation.directory, {
          outcome: 'delegate',
          summary: 'Use an offline export to work around the factory crash',
          artifacts: [
            {
              kind: 'decision',
              title: 'Repeated export failure',
              chose: 'factory: use an offline export',
              alternative: 'Retry the same Codex export',
              reason: 'Two identical Codex crashes after removing run details',
            },
          ],
          tasks: [
            {
              key: 'changed',
              title: 'Changed',
              instructions: 'Write an offline export to recovered.txt',
            },
          ],
        })
      }
      return result(invocation.directory, {
        outcome:
          tasks.find((task) => task.key === 'changed')!.status === 'merged'
            ? 'done'
            : 'delegate',
        summary: 'Offline export completes the work',
        artifacts: [],
      })
    }
    if (role === 'builder')
      return build(
        invocation,
        title === 'Changed' ? 'recovered.txt' : `${title}.txt`,
        'export\n',
      )
    return result(invocation.directory, {
      outcome: title === 'Changed' ? 'passed' : 'changes-needed',
      summary:
        title === 'Changed'
          ? 'Offline export works'
          : title === 'a'
            ? 'Codex crashed at /tmp/export-a/run.ts:12 for attempt #123 at 2026-10-06T12:34:56Z after 1.5 seconds'
            : 'Codex crashed at /Users/test/export-b/cli.ts:98 for attempt #456 at 2026-10-07T09:10:11Z after 250 ms',
      artifacts: [],
    })
  })
  const lead = await f.lead('Repeated failures', true)
  await f.start()
  const done = await until(
    () => f.detail(lead.number),
    (detail) =>
      detail.ticket.currentStep === 'confirm' ||
      detail.ticket.status === 'needs-you',
  )
  assert.equal(
    done.ticket.currentStep,
    'confirm',
    JSON.stringify(done.attempts),
  )
  assert.ok(sawRefusal)
  assert.deepEqual(
    done.tasks.map((task) => [task.key, task.status]),
    [
      ['a', 'failed'],
      ['b', 'failed'],
      ['changed', 'merged'],
    ],
  )
  for (const task of done.tasks.filter((item) => item.status === 'failed')) {
    assert.match(
      task.result!,
      /^Child ticket #\d+ was cancelled after review: Codex crashed/,
    )
    assert.equal(
      (await f.detail(task.child!.number)).ticket.status,
      'cancelled',
    )
  }
  assert.ok(
    done.artifacts.some(
      (artifact) =>
        artifact.title === 'Task report' &&
        /## Repeated failure\n\n- Same error 2 times: a, b\./.test(
          artifact.content ?? '',
        ),
    ),
  )
  assert.ok(
    done.artifacts.some(
      (artifact) =>
        artifact.decision?.chose === 'factory: use an offline export',
    ),
  )
  const refused = f.invocations.find(
    (invocation) =>
      invocation.role === 'lead' &&
      !invocation.prompt.includes('Previous result validation failed') &&
      leadState(invocation.prompt).repeatedFailure.length > 0,
  )!
  assert.match(
    await readFile(join(refused.directory, 'result-error.txt'), 'utf8'),
    /Invalid lead result:.*same instructions already failed 2 times/,
  )

  assert.deepEqual(f.errors, [])
})

test('pull request tasks are checked in their checkout and wait for the lead: merge goes through the merge step, leave-open stays for the owner', async (t) => {
  // No verify kit, so task-pr is the built-in workflow whose tester works in its checkout.
  const f = await leadFixture({}, 'missing')
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
    const file = `${title.toLowerCase()}.txt`
    if (role === 'builder') return build(invocation, file, `${title}\n`)
    if (role === 'tester') {
      const instance = proofContext(invocation.prompt).instances[0]!
      const path = join(instance.evidenceDir, file)
      await writeFile(
        path,
        await readFile(join(instance.checkout, file), 'utf8'),
      )
      return result(invocation.directory, {
        outcome: 'passed',
        summary: `Read ${file}`,
        artifacts: [
          {
            kind: 'evidence',
            title,
            path,
            scenario: title,
            scenarioResult: 'passed',
          },
        ],
      })
    }
    assert.equal(role, 'reviewer')
    return result(invocation.directory, {
      outcome: 'passed',
      summary: 'Reviewed',
      artifacts: [],
    })
  })
  const lead = await f.lead()
  await f.start()
  for (const key of ['keep', 'park']) {
    await until(
      () => f.detail(lead.number),
      (detail) =>
        detail.tasks.some(
          (task) =>
            task.key === key && ['pr-ready', 'left-open'].includes(task.status),
        ),
    )
    await until(
      () => f.detail(lead.number),
      (detail) =>
        detail.tasks.some((task) => task.key === key && task.decision !== null),
    )
  }
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
  assert.deepEqual(child.ticket.skippedSteps, [])
  assert.equal(
    child.attempts.find((attempt) => attempt.stepId === 'test')?.outcome,
    'passed',
  )
  assert.deepEqual(
    f.invocations
      .filter((item) => item.role === 'tester')
      .map((item) => item.title)
      .sort(),
    ['Keep', 'Park'],
  )
  assert.ok(
    !child.artifacts.some(
      (artifact) =>
        artifact.title === 'Pull request description' &&
        artifact.content?.includes('Untested'),
    ),
  )
  const gate = (await getMergeGate(f.database, child.ticket.id))!.latest
  assert.deepEqual(
    gate.needsOwner.filter((reason) => /Untested|Unverified/.test(reason)),
    [],
  )
  assert.equal(gate.ready, true)
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
      reviewers: [],
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
        summary: 'Two tasks',
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
    (reviewers) => reviewers.length === 2,
  )
  assert.match(leadPrompts[1]!, /some-other-model.*is not allowed/)
  const agentOf = (role: string, title: string) =>
    f.invocations.find((item) => item.role === role && item.title === title)
      ?.config
  assert.deepEqual(agentOf('lead', 'Lead the change'), { cli: 'codex' })
  assert.deepEqual(agentOf('builder', 'Chosen'), opusHigh)
  assert.deepEqual(agentOf('reviewer', 'Chosen'), globalReviewer)
  assert.deepEqual(agentOf('builder', 'Data'), sol)
  assert.deepEqual(agentOf('reviewer', 'Data'), opusMedium)
  const chosen = (await f.detail(lead.number)).tasks.find(
    (task) => task.key === 'chosen',
  )
  const child = await f.detail(chosen!.child!.number)
  assert.deepEqual(
    child.attempts.map((attempt) => [attempt.stepId, attempt.agent]),
    [
      ['build', opusHigh],
      ['review', globalReviewer],
    ],
  )
})

test("a lead's branch task is built, checked and merged with the checker's verdict, then the final test runs (no verify: the checker works in its checkout)", async (t) => {
  const f = await leadFixture({}, 'missing')
  t.after(() => f.close())
  f.setBehaviour(async (role, invocation) => {
    if (role === 'lead') {
      const { tasks } = leadState(invocation.prompt)
      return result(invocation.directory, {
        outcome: tasks.length ? 'done' : 'delegate',
        summary: 'One task',
        artifacts: [],
        ...(tasks.length
          ? {}
          : {
              tasks: [
                {
                  key: 'change',
                  title: 'Change',
                  instructions: 'Write change.txt',
                },
              ],
            }),
      })
    }
    if (role === 'builder') return build(invocation, 'change.txt', 'changed\n')
    if (role === 'reviewer')
      return result(invocation.directory, {
        outcome: 'passed',
        summary: 'Reviewed',
        artifacts: [],
      })
    assert.equal(role, 'tester')
    const context = proofContext(invocation.prompt)
    const instance = context.instances[0]!
    const path = join(instance.evidenceDir, 'observed.txt')
    assert.equal(context.app?.started, false)
    assert.equal(instance.url, null)
    await writeFile(
      path,
      await readFile(join(instance.checkout, 'change.txt'), 'utf8'),
    )
    return result(invocation.directory, {
      outcome: 'passed',
      summary: 'Checked the change',
      artifacts: [
        {
          kind: 'evidence',
          title: 'Change',
          path,
          scenario: 'Change',
          scenarioResult: 'passed',
        },
        {
          kind: 'evidence',
          title: 'Not seen in a browser',
          content: 'No app was started, so nobody looked at it.',
          scenario: 'Browser view',
          scenarioResult: 'unverified',
        },
      ],
    })
  })
  const lead = await createTicket(f.store.database, {
    repository: f.repository.slug,
    lightsOut: false,
    workflow: await builtInWorkflow('lead'),
    title: 'Lead the change',
    body: 'Build the whole feature through tasks.',
  })
  await f.start()
  const done = await until(
    () => f.detail(lead.number),
    (detail) => detail.ticket.waiting?.for === 'pull-request-merge',
  )
  const task = done.tasks[0]!
  assert.equal(task.status, 'merged')
  assert.ok((await f.files(done.ticket.branch)).includes('change.txt'))
  const child = await f.detail(task.child!.number)
  assert.equal(child.ticket.status, 'done')
  assert.deepEqual(child.ticket.skippedSteps, [])
  assert.deepEqual(
    child.attempts.map((attempt) => [attempt.stepId, attempt.outcome]),
    [
      ['build', 'done'],
      ['test', 'passed'],
    ],
  )
  const checked = child.attempts.find(
    (attempt) => attempt.stepId === 'test',
  )!.headCommit!
  assert.match(
    task.result!,
    new RegExp(
      `^Merged into the lead branch at [0-9a-f]{40}\\. Checker test passed at ${checked} with unverified items\\. Unverified by test: Browser view\\.$`,
    ),
  )
  assert.ok(
    done.artifacts.some(
      (artifact) =>
        artifact.title === 'Task report' &&
        artifact.content?.includes('Checker test passed'),
    ),
  )
  assert.equal(
    done.attempts.find((attempt) => attempt.stepId === 'final-test')?.outcome,
    'passed',
  )
  assert.deepEqual(
    f.invocations
      .filter((item) => item.role === 'tester')
      .map((item) => item.title),
    ['Change', 'Lead the change'],
  )
  const expected = ['Unverified by final-test: Browser view']
  assert.deepEqual(untestedReasons(done), expected)
  const snapshot = await until(
    () => getMergeGate(f.database, done.ticket.id),
    (gate) => gate?.latest.ready === true,
  )
  assert.deepEqual(
    snapshot!.latest.needsOwner.filter((reason) =>
      /Untested|Unverified/.test(reason),
    ),
    expected,
  )
  const description = done.artifacts.find(
    (artifact) => artifact.title === 'Pull request description',
  )?.content
  for (const reason of expected) assert.ok(description?.includes(reason))
  assert.doesNotMatch(description ?? '', /Untested/)
  assert.deepEqual(f.errors, [])
})
