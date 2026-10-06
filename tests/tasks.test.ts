import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { engineConfig } from '../src/config.ts'
import { runTasksParams } from '../src/domain/catalog.ts'
import { parseStepResult } from '../src/domain/lifecycle.ts'
import { ticketStatus } from '../src/domain/lifecycle.ts'
import {
  checkDelegation,
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

  test('rejects reused keys, unknown or mismatched workflows, other agents and too many tasks', async () => {
    const errors = checkDelegation(
      await input({
        existing: [
          { key: 'api', land: 'branch', status: 'merged', decision: null },
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
        decision: null,
      },
      {
        key: 'branch',
        land: 'branch' as const,
        status: 'running' as const,
        decision: null,
      },
      {
        key: 'decided',
        land: 'pr' as const,
        status: 'pr-ready' as const,
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
            { key: 'a', land: 'branch', status: 'merged', decision: null },
          ],
        }),
      ).join(),
      /nothing would run/,
    )
    assert.deepEqual(
      checkDelegation(
        await input({
          existing: [
            { key: 'a', land: 'branch', status: 'running', decision: null },
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
        decision: null,
      },
      {
        key: 'b',
        land: 'pr' as const,
        status: 'pr-ready' as const,
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
