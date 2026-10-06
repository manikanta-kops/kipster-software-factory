import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { engineConfig } from '../src/config.ts'
import { runTasksParams } from '../src/domain/catalog.ts'
import { parseStepResult } from '../src/domain/lifecycle.ts'
import { ticketStatus } from '../src/domain/lifecycle.ts'
import {
  checkDelegation,
  failureSignature,
  repeatedFailures,
  type DelegationInput,
  taskWorkflowProblem,
} from '../src/domain/tasks.ts'
import { parseWorkflow, type Workflow } from '../src/domain/workflow.ts'
import { cliCommand } from '../src/executors/cli.ts'
import { builtInLibrary } from './helpers/store.ts'

const workflow = (steps: string) =>
  `name: sample\ndescription: A sample workflow.\nsteps:\n${steps}`

function parsed(source: string): Workflow {
  const result = parseWorkflow(source)
  if (!result.ok) throw new Error(result.errors.join('\n'))
  return result.workflow
}

describe('lead workflows', () => {
  test('a lead must route delegate to a run-tasks step', () => {
    const result = parseWorkflow(
      workflow(`
  - id: lead
    kind: agent
    role: lead
  - id: build
    kind: agent
    role: builder
`),
    )
    assert.equal(result.ok, false)
    assert.match(
      result.ok ? '' : result.errors.join('\n'),
      /step "lead": route delegate to a run-tasks step/,
    )
  })

  test('run-tasks needs a lead that delegates to it', () => {
    const result = parseWorkflow(
      workflow(`
  - id: run
    kind: system
    action: run-tasks
`),
    )
    assert.equal(result.ok, false)
    assert.match(
      result.ok ? '' : result.errors.join('\n'),
      /run-tasks only runs a lead's tasks/,
    )
  })

  test('run-tasks parameters have defaults and reject unknown keys', () => {
    assert.deepEqual(runTasksParams.parse({}), {
      workflow: 'task',
      prWorkflow: 'task-pr',
      maxParallel: 3,
      maxTasks: 12,
    })
    const result = parseWorkflow(
      workflow(`
  - id: lead
    kind: agent
    role: lead
    routes:
      delegate: run
  - id: run
    kind: system
    action: run-tasks
    with:
      parallel: 2
    routes:
      reported: lead
`),
    )
    assert.equal(result.ok, false)
  })

  test('built-in lead, task and task-pr workflows load', async () => {
    const library = await builtInLibrary()
    const lead = library.get('lead')!.workflow
    assert.deepEqual(
      lead.steps.map((step) => step.id),
      [
        'lead',
        'approve-plan',
        'run-tasks',
        'final-test',
        'review',
        'maintain-pr',
        'merge',
      ],
    )
    assert.equal(
      taskWorkflowProblem(library.get('task')!.workflow, 'branch'),
      null,
    )
    assert.equal(
      taskWorkflowProblem(library.get('task-pr')!.workflow, 'pr'),
      null,
    )
    assert.match(
      taskWorkflowProblem(library.get('task-pr')!.workflow, 'branch')!,
      /publishes a pull request/,
    )
    assert.match(
      taskWorkflowProblem(library.get('task')!.workflow, 'pr')!,
      /needs maintain-pr and merge/,
    )
    assert.match(taskWorkflowProblem(lead, 'branch')!, /tasks cannot have/)
  })

  test('a ticket waiting for tasks is running, not needs-you', () => {
    assert.equal(
      ticketStatus({ status: 'waiting', next: null, waitingFor: 'tasks' }),
      'running',
    )
  })
})

describe('lead results', () => {
  test('tasks only with delegate; decisions with delegate or done', () => {
    const task = { key: 'api', title: 'API', instructions: 'Add the API.' }
    assert.equal(
      parseStepResult({
        outcome: 'delegate',
        summary: 'Split',
        artifacts: [],
        tasks: [task],
      }).tasks?.[0]?.land,
      'branch',
    )
    assert.throws(
      () =>
        parseStepResult({
          outcome: 'done',
          summary: 'Done',
          artifacts: [],
          tasks: [task],
        }),
      /only delegate can ask for tasks/,
    )
    assert.throws(
      () =>
        parseStepResult({
          outcome: 'passed',
          summary: 'Done',
          artifacts: [],
          pullRequests: [{ task: 'api', decision: 'merge' }],
        }),
      /only delegate or done can decide/,
    )
    assert.throws(
      () =>
        parseStepResult({
          outcome: 'delegate',
          summary: 'Split',
          artifacts: [],
          tasks: [{ ...task, key: 'Bad Key' }],
        }),
      /tasks\.0\.key/,
    )
  })

  const library = builtInLibrary()
  async function input(
    change: Partial<DelegationInput>,
  ): Promise<DelegationInput> {
    const workflows = await library
    return {
      outcome: 'delegate',
      tasks: [],
      pullRequests: [],
      existing: [],
      params: runTasksParams.parse({ maxTasks: 3 }),
      workflows: (name) => workflows.get(name)?.workflow,
      allowedAgents: [{ cli: 'claude', model: 'opus', effort: 'high' }],
      ...change,
    }
  }
  const request = (key: string, extra: object = {}) => ({
    key,
    title: key,
    instructions: `Do ${key}`,
    land: 'branch' as const,
    ...extra,
  })

  test('accepts new tasks with allowed agents and the right workflows', async () => {
    assert.deepEqual(
      checkDelegation(
        await input({
          tasks: [
            request('api', {
              agent: { cli: 'claude', model: 'opus', effort: 'high' },
            }),
            request('docs', { land: 'pr' }),
          ],
        }),
      ),
      [],
    )
  })

  test('refuses repeated failure instructions, allowing whitespace changes only before repetition', async () => {
    const existing = ['a', 'b'].map((key) => ({
      key,
      land: 'branch' as const,
      status: 'failed' as const,
      decision: null,
      instructions: key === 'a' ? 'Run the export' : 'Try the smaller export',
      result: `Codex crashed in /tmp/${key}/run.log at 2026-10-06T12:00:00Z`,
    }))
    for (const instructions of [
      ' Run\n the   export ',
      'Try the smaller export',
    ]) {
      const errors = checkDelegation(
        await input({
          existing,
          tasks: [request('retry', { instructions })],
        }),
      ).join('\n')
      assert.match(
        errors,
        /same instructions already failed 2 times with the same error \(a, b\)/,
      )
      assert.match(
        errors,
        /classify the cause \(task, plan or factory\), record it as a decision artifact/,
      )
      assert.match(
        errors,
        /change the task or the plan, or park that line of work and continue the rest/,
      )
    }
    assert.deepEqual(
      checkDelegation(
        await input({
          existing,
          tasks: [
            request('retry', {
              instructions: 'Use the offline export instead',
            }),
          ],
        }),
      ),
      [],
    )
    assert.deepEqual(
      checkDelegation(
        await input({
          existing: existing.slice(0, 1),
          tasks: [request('retry', { instructions: 'Run the export' })],
        }),
      ),
      [],
    )
    assert.deepEqual(
      checkDelegation(
        await input({
          existing: existing.map((task) => ({
            ...task,
            status: 'conflict' as const,
          })),
          tasks: [request('retry', { instructions: 'Run the export' })],
        }),
      ),
      [],
    )
  })

  test('rejects reused keys, unknown or mismatched workflows, other agents and too many tasks', async () => {
    const errors = checkDelegation(
      await input({
        existing: [
          {
            key: 'api',
            land: 'branch',
            status: 'merged',
            instructions: 'Existing task',
            result: null,
            decision: null,
          },
        ],
        tasks: [
          request('api'),
          request('ui', { workflow: 'missing' }),
          request('pr', { workflow: 'task-pr' }),
          request('model', { agent: { cli: 'codex', model: 'gpt' } }),
        ],
      }),
    ).join('\n')
    assert.match(errors, /task "api": key is already used/)
    assert.match(errors, /task "ui": no workflow "missing"/)
    assert.match(errors, /task "pr": .*publishes a pull request/)
    assert.match(errors, /task "model": agent .* is not allowed/)
    assert.match(errors, /at most 3 tasks; it has 1 and asked for 4/)
  })

  test('pull request decisions need an undecided ready pr task', async () => {
    const existing = [
      {
        key: 'ready',
        land: 'pr' as const,
        status: 'pr-ready' as const,
        instructions: 'Existing task',
        result: null,
        decision: null,
      },
      {
        key: 'branch',
        land: 'branch' as const,
        status: 'running' as const,
        instructions: 'Existing task',
        result: null,
        decision: null,
      },
      {
        key: 'decided',
        land: 'pr' as const,
        status: 'pr-ready' as const,
        instructions: 'Existing task',
        result: null,
        decision: 'merge' as const,
      },
    ]
    assert.deepEqual(
      checkDelegation(
        await input({
          existing,
          pullRequests: [{ task: 'ready', decision: 'merge' }],
        }),
      ),
      [],
    )
    const errors = checkDelegation(
      await input({
        existing,
        pullRequests: [
          { task: 'branch', decision: 'merge' },
          { task: 'decided', decision: 'leave-open' },
          { task: 'missing', decision: 'merge' },
        ],
      }),
    ).join('\n')
    assert.match(errors, /"branch": the task is a branch task/)
    assert.match(errors, /"decided": only an undecided ready pull request/)
    assert.match(errors, /"missing": no such task/)
  })

  test('delegate must leave something to wait for', async () => {
    assert.match(
      checkDelegation(
        await input({
          existing: [
            {
              key: 'a',
              land: 'branch',
              status: 'merged',
              instructions: 'Existing task',
              result: null,
              decision: null,
            },
          ],
        }),
      ).join(),
      /nothing would run/,
    )
    assert.deepEqual(
      checkDelegation(
        await input({
          existing: [
            {
              key: 'a',
              land: 'branch',
              status: 'running',
              instructions: 'Existing task',
              result: null,
              decision: null,
            },
          ],
        }),
      ),
      [],
    )
  })

  test('done needs every task finished, allowing leave-open decisions but not merge', async () => {
    const existing = [
      {
        key: 'a',
        land: 'branch' as const,
        status: 'merged' as const,
        instructions: 'Existing task',
        result: null,
        decision: null,
      },
      {
        key: 'b',
        land: 'pr' as const,
        status: 'pr-ready' as const,
        instructions: 'Existing task',
        result: null,
        decision: null,
      },
    ]
    assert.match(
      checkDelegation(await input({ outcome: 'done', existing })).join(),
      /still open: b \(pr-ready\)/,
    )
    assert.deepEqual(
      checkDelegation(
        await input({
          outcome: 'done',
          existing,
          pullRequests: [{ task: 'b', decision: 'leave-open' }],
        }),
      ),
      [],
    )
    assert.match(
      checkDelegation(
        await input({
          outcome: 'done',
          existing,
          pullRequests: [{ task: 'b', decision: 'merge' }],
        }),
      ).join(),
      /merge needs delegate/,
    )
  })
})

describe('task failure signatures', () => {
  test('crashes differing only in paths, IDs, hashes, timestamps, durations and numbers match', () => {
    const first =
      'Child ticket #123 was cancelled after build: Codex crashed at /Users/alex/work/run.ts:12:3 with attempt #456 UUID 550e8400-e29b-41d4-a716-446655440000 commit abcdef1234567890 at 2026-10-06T12:34:56.123Z after 1.5 seconds, exit 137. Stack ./src/cli.ts ../tmp/error.log src/engine/tasks.ts'
    const second =
      'Child ticket #789 was cancelled after build: CODEX crashed at /tmp/other/entry.ts:99:7 with attempt #987 UUID 4e6749d2-8536-44b6-91d2-26e48ec76665 commit 1234567abcdefabc at 2026-11-07T09:10:11.987+02:00 after 250 ms, exit 1. Stack ./lib/main.ts ../logs/crash.txt tests/helpers/lead.ts'
    assert.equal(failureSignature(first), failureSignature(second))
    assert.match(failureSignature(first), /codex crashed/)
    assert.notEqual(
      failureSignature(first),
      failureSignature(first.replace('Codex crashed', 'Permission denied')),
    )
  })

  test('normalises Windows and relative paths, common timestamp formats and durations', () => {
    for (const [first, second] of [
      [
        'Error in C:\\work\\a.ts:10 and logs\\a.log',
        'Error in D:\\temp\\b.ts:20 and output\\b.log',
      ],
      ['Crash at 10/06/2026 12:34:56 UTC', 'Crash at 11/07/2026 01:23:45 GMT'],
      [
        'Crash at Tue, 06 Oct 2026 12:34:56 GMT',
        'Crash at Wed, 07 Oct 2026 01:23:45 GMT',
      ],
      [
        'Crash at October 6, 2026 12:34 PM',
        'Crash at November 7, 2026 01:23 AM',
      ],
      ['Crash after 1m30s', 'Crash after 200ms'],
      ['Crash at Tue Oct 6 12:34:56 2026', 'Crash at Wed Nov 7 01:23:45 2026'],
      [
        'Error in input.csv and schema.xml',
        'Error in output.bin and data.custom',
      ],
      [
        'Error in "/tmp/My Run/trace.log"',
        'Error in "/Users/test/Other Run/error.txt"',
      ],
      [
        'Error in crash.log and ./cache/data.csv',
        'Error in other.txt and ../tmp/data.json',
      ],
      ['Error with deadbeef and #123', 'Error with 0123456789abcdef and #456'],
      [
        'Crash at address 0x7ffdeadbeef after 30µs',
        'Crash at address 0x123abcdef after 20ns',
      ],
    ] as const)
      assert.equal(failureSignature(first), failureSignature(second), first)
    assert.equal(
      failureSignature('  CODEX\n crashed\t unexpectedly  '),
      'codex crashed unexpectedly',
    )
  })

  test('groups only failed tasks with nonempty signatures, preserving every key and count', () => {
    const tasks = [
      {
        key: 'a',
        status: 'failed' as const,
        result: 'Codex crashed at /tmp/a.log',
      },
      {
        key: 'b',
        status: 'failed' as const,
        result: 'Codex crashed at /tmp/b.log',
      },
      {
        key: 'c',
        status: 'failed' as const,
        result: 'Codex crashed at ./logs/c.log',
      },
      {
        key: 'different',
        status: 'failed' as const,
        result: 'Permission denied',
      },
      ...(
        ['conflict', 'cancelled', 'merged', 'running', 'parked'] as const
      ).map((status) => ({
        key: status,
        status,
        result: 'Codex crashed at /tmp/d.log',
      })),
      { key: 'missing', status: 'failed' as const, result: null },
      { key: 'empty', status: 'failed' as const, result: ' ' },
      { key: 'numeric', status: 'failed' as const, result: '123' },
    ]
    assert.deepEqual(repeatedFailures(tasks), [
      { signature: 'codex crashed at', count: 3, tasks: ['a', 'b', 'c'] },
    ])
    assert.deepEqual(repeatedFailures(tasks.slice(0, 1)), [])
    assert.deepEqual(repeatedFailures([]), [])
  })
})

describe('agent choices', () => {
  test('effort reaches both CLIs; the allow-list defaults to empty', () => {
    assert.deepEqual(
      cliCommand({ cli: 'claude', model: 'opus', effort: 'high' }).args.slice(
        -4,
      ),
      ['--model', 'opus', '--effort', 'high'],
    )
    const codex = cliCommand({ cli: 'codex', effort: 'xhigh' }).args
    assert.deepEqual(codex.slice(-3), [
      '-c',
      'model_reasoning_effort="xhigh"',
      '-',
    ])
    const config = engineConfig.parse({})
    assert.deepEqual(config.agents.allowed, [])
    assert.throws(() =>
      engineConfig.parse({
        agents: { default: { cli: 'claude', effort: 'extreme' } },
      }),
    )
    assert.equal(
      engineConfig.parse({ agents: { roles: { lead: { cli: 'claude' } } } })
        .agents.roles.lead?.cli,
      'claude',
    )
  })

  test('a lead workflow parses with its delegate loop', () => {
    const lead = parsed(
      workflow(`
  - id: lead
    kind: agent
    role: lead
    routes:
      delegate: run
  - id: run
    kind: system
    action: run-tasks
    limit: 4
    routes:
      reported: lead
`),
    )
    assert.equal(lead.steps.length, 2)
  })
})
