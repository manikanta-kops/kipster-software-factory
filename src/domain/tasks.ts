// Rules for a lead's tasks: which requests are valid, which workflows a task may run,
// and when a lead may finish. The store and engine apply them.
import type {
  AgentChoice,
  PullRequestDecision,
  RunTasksParams,
  TaskRequest,
} from './catalog.ts'
import type { LeadTask, TaskStatus } from './records.ts'
import type { SystemStep, Workflow } from './workflow.ts'

/** A task in one of these states never changes again. */
export const FINAL_TASK_STATUSES: readonly TaskStatus[] = [
  'merged',
  'left-open',
  'conflict',
  'failed',
  'cancelled',
]

/** Changes the lead is woken for. `left-open` and `cancelled` come from the lead or the owner. */
export const REPORTED_TASK_STATUSES: readonly TaskStatus[] = [
  'parked',
  'pr-ready',
  'merged',
  'conflict',
  'failed',
]

export type TaskState = Pick<
  LeadTask,
  'key' | 'land' | 'status' | 'decision' | 'instructions' | 'result'
>

export interface RepeatedFailure {
  readonly signature: string
  readonly count: number
  readonly tasks: readonly string[]
}

/** Remove run-specific details while keeping the error's words. */
export function failureSignature(text: string): string {
  return text
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      ' ',
    )
    .replace(/\b(?:0x)?[0-9a-f]{7,}\b/gi, ' ')
    .replace(
      /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/gi,
      ' ',
    )
    .replace(/\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/g, ' ')
    .replace(
      /\b(?:Mon|Tues?|Wed(?:nes)?|Thurs?|Fri|Sat(?:ur)?|Sun)(?:day)?[,]?\s+/gi,
      ' ',
    )
    .replace(
      /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+(?:\d{1,2}:\d{2}:\d{2}\s+)?\d{4}\b/gi,
      ' ',
    )
    .replace(
      /\b\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}\b/gi,
      ' ',
    )
    .replace(
      /\b\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:\s*(?:AM|PM|UTC|GMT)|Z|[+-]\d{2}:?\d{2})?\b/gi,
      ' ',
    )
    .replace(
      /(["'`])(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/]|\/|[\w.-]+[\\/])[^\r\n]*?\1/g,
      ' ',
    )
    .replace(
      /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/]|\/)[^\s"'`<>()[\]{},;]+|\b[\w.-]+(?:[\\/][\w.-]+)+(?::\d+(?::\d+)?)?/g,
      ' ',
    )
    .replace(/\b[\w.-]+\.[a-z][\w-]*(?::\d+(?::\d+)?)?\b/gi, ' ')
    .replace(
      /\b(?:\d+(?:\.\d+)?\s*(?:nanoseconds?|ns|microseconds?|us|µs|μs|milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\s*)+\b/gi,
      ' ',
    )
    .replace(/#\d+|\d+(?:\.\d+)?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export function repeatedFailures(
  tasks: readonly Pick<TaskState, 'key' | 'status' | 'result'>[],
): RepeatedFailure[] {
  const groups = new Map<string, string[]>()
  for (const task of tasks) {
    if (task.status !== 'failed' || !task.result?.trim()) continue
    const signature = failureSignature(task.result)
    if (!signature) continue
    const keys = groups.get(signature) ?? []
    keys.push(task.key)
    groups.set(signature, keys)
  }
  return [...groups].flatMap(([signature, keys]) =>
    keys.length >= 2 ? [{ signature, count: keys.length, tasks: keys }] : [],
  )
}

function normaliseInstructions(instructions: string): string {
  return instructions.replace(/\s+/g, ' ').trim()
}

export function isFinalTask(status: TaskStatus): boolean {
  return FINAL_TASK_STATUSES.includes(status)
}

/** Work the lead is still waiting on: queued or running tasks, and pull requests it chose to merge. */
export function isActiveTask(task: Pick<TaskState, 'status' | 'decision'>) {
  return (
    task.status === 'pending' ||
    task.status === 'running' ||
    task.status === 'parked' ||
    (task.status === 'pr-ready' && task.decision === 'merge')
  )
}

export function taskWorkflowName(
  task: Pick<TaskRequest, 'land' | 'workflow'>,
  params: RunTasksParams,
): string {
  return (
    task.workflow ?? (task.land === 'pr' ? params.prWorkflow : params.workflow)
  )
}

/** The run-tasks step a lead step's `delegate` outcome goes to. */
export function delegateTarget(
  workflow: Workflow,
  leadStepId: string,
): SystemStep | undefined {
  const lead = workflow.steps.find((step) => step.id === leadStepId)
  const target = workflow.steps.find(
    (step) => step.id === lead?.routes['delegate'],
  )
  return target?.kind === 'system' && target.action === 'run-tasks'
    ? target
    : undefined
}

/** Why a workflow cannot run a task that lands this way, or null when it can. */
export function taskWorkflowProblem(
  workflow: Workflow,
  land: 'branch' | 'pr',
): string | null {
  const actions = new Set(
    workflow.steps.flatMap((step) =>
      step.kind === 'system' ? [step.action] : [],
    ),
  )
  if (
    workflow.steps.some((step) => step.kind === 'agent' && step.role === 'lead')
  )
    return `workflow "${workflow.name}" has a lead step; tasks cannot have tasks`
  if (land === 'branch' && (actions.has('maintain-pr') || actions.has('merge')))
    return `workflow "${workflow.name}" publishes a pull request; a branch task must only build and check, because the system merges it into the lead's branch`
  if (land === 'pr' && !(actions.has('maintain-pr') && actions.has('merge')))
    return `workflow "${workflow.name}" needs maintain-pr and merge steps for a pr task`
  return null
}

export function sameAgent(a: AgentChoice, b: AgentChoice): boolean {
  return a.cli === b.cli && a.model === b.model && a.effort === b.effort
}

export interface DelegationInput {
  readonly outcome: string
  readonly tasks: readonly TaskRequest[]
  readonly pullRequests: readonly PullRequestDecision[]
  readonly existing: readonly TaskState[]
  readonly params: RunTasksParams
  readonly workflows: (name: string) => Workflow | undefined
  readonly allowedAgents: readonly AgentChoice[]
}

/** Problems with a lead's result given its ticket's tasks; empty when the result can be applied. */
export function checkDelegation(input: DelegationInput): string[] {
  const { existing, params } = input
  if (input.outcome !== 'delegate' && input.outcome !== 'done') return []
  const errors = checkDecisions(input)
  if (input.outcome === 'done') {
    if (input.tasks.length > 0)
      errors.push('done cannot ask for tasks; report delegate instead')
    for (const { task, decision } of input.pullRequests)
      if (decision === 'merge')
        errors.push(
          `pull request decision for "${task}": merge needs delegate, so the system can report the merge`,
        )
    const leftOpen = new Set(input.pullRequests.map((item) => item.task))
    const open = existing.filter(
      (task) => !isFinalTask(task.status) && !leftOpen.has(task.key),
    )
    if (open.length > 0)
      errors.push(
        `done needs every task finished; still open: ${open.map((task) => `${task.key} (${task.status}${task.decision ? `, ${task.decision}` : ''})`).join(', ')}. Report delegate to keep waiting, or decide merge or leave-open on ready pull requests.`,
      )
    return errors
  }

  const keys = new Set(existing.map((task) => task.key))
  const repeated = repeatedFailures(existing)
  for (const task of input.tasks) {
    const at = `task "${task.key}"`
    for (const group of repeated) {
      if (
        existing.some(
          (previous) =>
            group.tasks.includes(previous.key) &&
            normaliseInstructions(previous.instructions) ===
              normaliseInstructions(task.instructions),
        )
      )
        errors.push(
          `${at}: the same instructions already failed ${group.count} times with the same error (${group.tasks.join(', ')}). The lead must classify the cause (task, plan or factory), record it as a decision artifact, and change the task or the plan, or park that line of work and continue the rest.`,
        )
    }
    if (keys.has(task.key))
      errors.push(`${at}: key is already used; give new work a new key`)
    keys.add(task.key)
    const name = taskWorkflowName(task, params)
    const workflow = input.workflows(name)
    if (!workflow) errors.push(`${at}: no workflow "${name}"`)
    else {
      const problem = taskWorkflowProblem(workflow, task.land)
      if (problem) errors.push(`${at}: ${problem}`)
    }
    if (
      task.agent &&
      !input.allowedAgents.some((allowed) => sameAgent(allowed, task.agent!))
    )
      errors.push(
        `${at}: agent ${JSON.stringify(task.agent)} is not allowed; choose one of ${JSON.stringify(input.allowedAgents)} or omit agent`,
      )
  }
  if (existing.length + input.tasks.length > params.maxTasks)
    errors.push(
      `this ticket may have at most ${params.maxTasks} tasks; it has ${existing.length} and asked for ${input.tasks.length} more`,
    )

  const waiting =
    input.tasks.length +
    input.pullRequests.filter((item) => item.decision === 'merge').length +
    existing.filter(isActiveTask).length
  if (errors.length === 0 && waiting === 0)
    errors.push(
      'nothing would run: add tasks, decide merge on a ready pull request, or report done',
    )
  return errors
}

function checkDecisions(input: DelegationInput): string[] {
  const errors: string[] = []
  const decided = new Set<string>()
  for (const { task: key, decision } of input.pullRequests) {
    const at = `pull request decision for "${key}"`
    const task = input.existing.find((item) => item.key === key)
    if (decided.has(key)) errors.push(`${at}: decided twice`)
    decided.add(key)
    if (!task) errors.push(`${at}: no such task`)
    else if (task.land !== 'pr') errors.push(`${at}: the task is a branch task`)
    else if (task.status !== 'pr-ready' || task.decision !== null)
      errors.push(
        `${at}: only an undecided ready pull request can take ${decision}; it is ${task.status}${task.decision ? ` (${task.decision})` : ''}`,
      )
  }
  return errors
}

/** A task that ended this way can be replaced by a retry. */
export const ENDED_WITHOUT_LANDING: readonly TaskStatus[] = [
  'cancelled',
  'failed',
  'conflict',
]

/** A retried task takes a new key with a `-<n>` suffix, so `export`, `export-2` and `export-3` share a stem. */
function keyStem(key: string): string {
  return key.replace(/-\d+$/, '')
}

/**
 * For each task that ended without landing and was retried, the child ticket number
 * of the task that replaced it: the earliest later task with the same key stem, once
 * that task has a child ticket.
 */
export function replacements(
  tasks: readonly (Pick<LeadTask, 'key' | 'status' | 'createdAt'> & {
    readonly child: { readonly number: number } | null
  })[],
): Map<string, number> {
  const replaced = new Map<string, number>()
  for (const task of tasks) {
    if (!ENDED_WITHOUT_LANDING.includes(task.status)) continue
    const stem = keyStem(task.key)
    const after = Date.parse(task.createdAt)
    const successor = tasks
      .filter(
        (other) =>
          keyStem(other.key) === stem && Date.parse(other.createdAt) > after,
      )
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0]
    if (successor?.child) replaced.set(task.key, successor.child.number)
  }
  return replaced
}
