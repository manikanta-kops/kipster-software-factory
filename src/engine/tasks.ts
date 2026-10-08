import { checkerVerdict } from '../domain/task-testing.ts'
import type { AgentConfig } from '../config.ts'
import { type RoleName, runTasksParams } from '../domain/catalog.ts'
import { FactoryError } from '../domain/errors.ts'
import { stepOf, type StepResult } from '../domain/lifecycle.ts'
import type { LeadTask, Repository, Ticket } from '../domain/records.ts'
import {
  resolveAgent,
  independentAgent,
  describeAgent,
} from '../domain/settings.ts'
import type { ArtifactInput } from '../domain/lifecycle.ts'
import {
  checkDelegation,
  delegateTarget,
  repeatedFailures,
  keptTaskWork,
} from '../domain/tasks.ts'
import type { AgentStep } from '../domain/workflow.ts'
import {
  BUILT_IN_WORKFLOWS,
  type Library,
  loadLibrary,
} from '../library/library.ts'
import { getRepositoryById } from '../store/repositories.ts'
import {
  getTaskOfChild,
  listTasks,
  reportTasks,
  startTask,
  updateTask,
} from '../store/tasks.ts'
import {
  type AttemptContext,
  getTicketDetail,
  type TicketDetail,
} from '../store/tickets.ts'
import { run } from '../executors/process.ts'
import type { RunnerOptions } from './runner.ts'

/** All selections for one attempt, computed from its settings snapshot before execution. */
export async function agentsFor(
  options: Pick<RunnerOptions, 'database' | 'config'>,
  context: Pick<AttemptContext, 'ticket' | 'workflow'>,
  role: RoleName,
): Promise<{ agents: AgentConfig[]; notes: ArtifactInput[] }> {
  const { config, database } = options
  const workflow = context.workflow.name
  const owned = await getTaskOfChild(database, context.ticket.id)
  const original = resolveAgent(config, {
    workflow,
    role,
    taskAgent: owned?.task.agent,
  })
  if (!['reviewer', 'tester'].includes(role))
    return { agents: [original], notes: [] }
  const detail = (await getTicketDetail(database, context.ticket.number))!
  const builderAgents = (item: TicketDetail) =>
    item.attempts.flatMap((attempt) =>
      attempt.agent &&
      item.workflow.steps.some(
        (step) =>
          step.id === attempt.stepId &&
          step.kind === 'agent' &&
          step.role === 'builder',
      )
        ? [attempt.agent]
        : [],
    )
  const builders = builderAgents(detail)
  const children = await Promise.all(
    detail.tasks.flatMap((task) =>
      task.child ? [getTicketDetail(database, task.child.number)] : [],
    ),
  )
  for (const child of children)
    if (child) builders.push(...builderAgents(child))
  if (!builders.length)
    builders.push(
      resolveAgent(config, {
        workflow,
        role: 'builder',
        taskAgent: owned?.task.agent,
      }),
    )
  const override = config.workflows?.[workflow]
  const reviewers = override?.reviewers ?? config.agents.reviewers
  const candidates = [
    ...(role === 'reviewer' ? (override?.reviewers ?? []) : []),
    ...(override?.roles?.[role] ? [override.roles[role]!] : []),
    ...(config.agents.roles[role] ? [config.agents.roles[role]!] : []),
    ...config.agents.reviewers,
    ...config.agents.allowed,
    config.agents.default,
  ]
  const isLead = context.workflow.steps.some(
    (step) => step.kind === 'agent' && step.role === 'lead',
  )
  const originals =
    role === 'reviewer' && isLead && reviewers.length ? reviewers : [original]
  const notes: ArtifactInput[] = []
  const agents = originals.map((agent) => {
    const selection = independentAgent(agent, builders, candidates)
    if (selection.replaced || !selection.independent)
      notes.push({
        kind: 'note',
        title: selection.independent
          ? `${role} agent replaced for independence`
          : role === 'reviewer'
            ? 'Review was not independent'
            : 'Testing was not independent',
        content: selection.independent
          ? `Replaced ${describeAgent(agent)} with ${describeAgent(selection.agent)} because the original CLI and model match a builder of this change.`
          : `Running ${describeAgent(agent)} despite matching a builder of this change. No configured candidate has a different CLI and model. The owner must merge this head.`,
      })
    return selection.agent
  })
  return { agents, notes }
}

/** Reuse the recorded selection for this attempt; writers in system steps resolve separately. */
export async function agentFor(
  options: Pick<RunnerOptions, 'database' | 'config'>,
  context: Pick<AttemptContext, 'ticket' | 'workflow'> &
    Partial<Pick<AttemptContext, 'attempt' | 'step'>>,
  role: RoleName,
): Promise<AgentConfig> {
  if (
    context.attempt?.agent &&
    context.step?.kind === 'agent' &&
    context.step.role === role
  )
    return context.attempt.agent
  return (await agentsFor(options, context, role)).agents[0]!
}

async function libraryOf(options: RunnerOptions): Promise<Library> {
  if (options.library) return options.library
  const loaded = await loadLibrary(BUILT_IN_WORKFLOWS)
  if (!loaded.ok) throw new Error(loaded.errors.join('\n'))
  return loaded.library
}

/** What a lead sees about its tasks and the choices it has. */
export async function leadContext(
  options: RunnerOptions,
  context: AttemptContext,
  detail: TicketDetail,
) {
  const library = await libraryOf(options)
  const params = runTasksParams.parse(
    delegateTarget(context.workflow, context.step.id)?.with ?? {},
  )
  return {
    repeatedFailure: repeatedFailures(detail.tasks),
    tasks: detail.tasks.map((task) => ({
      key: task.key,
      title: task.title,
      land: task.land,
      workflow: task.workflow,
      agent: task.agent,
      status: task.status,
      decision: task.decision,
      result: task.result,
      child: task.child && {
        ticket: task.child.number,
        status: task.child.status,
        step: task.child.currentStep,
        waiting: task.child.waiting?.summary ?? task.child.waiting?.for ?? null,
        pullRequestUrl: task.child.pullRequestUrl,
        branch: task.child.branch,
      },
    })),
    limits: params,
    workflows: [...library.values()].map((entry) => ({
      name: entry.workflow.name,
      description: entry.workflow.description,
    })),
    allowedAgents: options.config.agents.allowed,
    autoMerge: !!context.repository.autoMerge,
  }
}

/** Why a lead's result cannot be applied, or null. A problem gets the usual fresh retry. */
export async function leadResultProblem(
  options: RunnerOptions,
  context: AttemptContext,
  result: StepResult,
): Promise<string | null> {
  const library = await libraryOf(options)
  const step = context.step as AgentStep
  const errors = checkDelegation({
    outcome: result.outcome,
    tasks: result.tasks ?? [],
    pullRequests: result.pullRequests ?? [],
    existing: await listTasks(options.database, context.ticket.id),
    params: runTasksParams.parse(
      delegateTarget(context.workflow, step.id)?.with ?? {},
    ),
    workflows: (name) => library.get(name)?.workflow,
    allowedAgents: options.config.agents.allowed,
  })
  return errors.length ? `Invalid lead result: ${errors.join('; ')}` : null
}

/**
 * Advances a parked run-tasks step: records what finished children did, merges finished
 * branch tasks into the lead's branch, starts queued tasks within the parallel limit,
 * and reports to the lead when something changed.
 */
export async function pollTasks(
  options: RunnerOptions,
  wait: { readonly attemptId: number; readonly ticketNumber: number },
  signal: AbortSignal,
): Promise<void> {
  const { database } = options
  const detail = await getTicketDetail(database, wait.ticketNumber)
  const attempt = detail?.attempts.at(-1)
  if (
    !detail ||
    attempt?.id !== wait.attemptId ||
    attempt.status !== 'waiting' ||
    attempt.waitingFor !== 'tasks'
  )
    return
  const step = stepOf(detail.workflow, attempt.stepId)
  const params = runTasksParams.parse(step.kind === 'system' ? step.with : {})
  const repository = (await getRepositoryById(
    database,
    detail.ticket.repository.id,
  )) as Repository

  for (const task of detail.tasks) {
    signal.throwIfAborted()
    const child = task.child
    if (!child || !['running', 'parked', 'pr-ready'].includes(task.status))
      continue
    if (
      detail.ticket.lightsOut &&
      child.waiting?.askReason === 'needs-decision'
    ) {
      await updateTask(
        database,
        task.id,
        'parked',
        child.waiting.summary ?? 'Child needs a decision.',
      )
      continue
    }
    if (task.status === 'parked')
      await updateTask(
        database,
        task.id,
        'running',
        'Child resumed after its decision.',
      )
    if (child.status === 'done') {
      if (task.land === 'branch')
        await integrate(options, detail.ticket, repository, task, signal)
      else
        await updateTask(
          database,
          task.id,
          'merged',
          `Pull request merged: ${child.pullRequestUrl ?? 'unknown URL'}. ${await taskVerdict(options, child.number)}`,
        )
    } else if (child.status === 'cancelled')
      await updateTask(
        database,
        task.id,
        'failed',
        await childEnding(options, repository, child.number, signal),
      )
    else if (
      task.land === 'pr' &&
      task.status === 'running' &&
      child.waiting?.for === 'pull-request-merge'
    )
      await updateTask(
        database,
        task.id,
        'pr-ready',
        `Pull request ready for a decision: ${child.pullRequestUrl ?? 'unknown URL'}`,
      )
  }

  const tasks = await listTasks(database, detail.ticket.id)
  let running = tasks.filter((task) => task.status === 'running').length
  const library = await libraryOf(options)
  for (const task of tasks.filter((item) => item.status === 'pending')) {
    if (running >= params.maxParallel) break
    signal.throwIfAborted()
    try {
      const entry = library.get(task.workflow)
      if (!entry)
        throw new FactoryError('invalid', `No workflow "${task.workflow}"`)
      const base =
        task.land === 'branch'
          ? await options.workspaces.head(detail.ticket, signal)
          : null
      await startTask(
        database,
        task.id,
        {
          repository: repository.slug,
          workflow: entry,
          title: task.title,
          body: childBody(detail.ticket, task),
          dependencies: detail.dependencies.map((item) => item.slug),
        },
        base,
      )
      running++
    } catch (error) {
      if (!(error instanceof FactoryError)) throw error
      await updateTask(
        database,
        task.id,
        'failed',
        `Could not start: ${error.message}`,
      )
    }
  }
  await reportTasks(database, wait.attemptId)
}

async function integrate(
  options: RunnerOptions,
  lead: Ticket,
  repository: Repository,
  task: LeadTask,
  signal: AbortSignal,
) {
  const branch = task.child!.branch
  let merged: Awaited<ReturnType<typeof options.workspaces.mergeInto>>
  try {
    merged = await options.workspaces.mergeInto(
      lead,
      repository,
      branch,
      `Merge task ${task.key}: ${task.title}`,
      signal,
    )
  } catch (error) {
    signal.throwIfAborted()
    // Retrying every tick would not help; the lead decides what to do with the branch.
    await updateTask(
      options.database,
      task.id,
      'failed',
      `Could not merge into the lead branch: ${String(error).slice(0, 1000)}. ${await childWork(options, repository, task.child!, signal)}`,
    )
    return
  }
  await updateTask(
    options.database,
    task.id,
    merged.conflicts ? 'conflict' : 'merged',
    merged.conflicts
      ? `Conflicts with the lead branch; the system aborted the merge. Files: ${merged.conflicts.join(', ')}. Branch ${branch} keeps the work.`
      : mergedTaskResult(
          merged.head,
          await taskVerdict(options, task.child!.number),
        ),
  )
}

/** A branch task's result once the system merged it into the lead's branch. */
export function mergedTaskResult(head: string, verdict: string): string {
  return `Merged into the lead branch at ${head}. ${verdict}`
}

async function taskVerdict(options: RunnerOptions, number: number) {
  const child = await getTicketDetail(options.database, number)
  return child ? checkerVerdict(child) : 'No checker ran.'
}

async function childWork(
  options: RunnerOptions,
  repository: Repository,
  child: { branch: string },
  signal: AbortSignal,
) {
  let head: string | null = null
  try {
    head = await run(
      'git',
      ['rev-parse', '--verify', `refs/heads/${child.branch}`],
      {
        cwd: options.workspaces.cache(repository),
        signal,
      },
    )
  } catch {
    signal.throwIfAborted()
  }
  return keptTaskWork(child.branch, head)
}

async function childEnding(
  options: RunnerOptions,
  repository: Repository,
  number: number,
  signal: AbortSignal,
) {
  const child = await getTicketDetail(options.database, number)
  const last = child?.attempts.findLast(
    (attempt) => attempt.summary || attempt.error,
  )
  const reason = child?.artifacts.findLast(
    (artifact) => artifact.title === 'Why it was cancelled',
  )?.content
  return `Child ticket #${number} was cancelled${last ? ` after ${last.stepId}: ${(last.summary ?? last.error)!.slice(0, 1000)}` : ''}${reason ? ` Reason: ${reason.slice(0, 500)}` : ''}. ${child ? await childWork(options, repository, child.ticket, signal) : 'Child branch unavailable.'}`
}

function childBody(lead: Ticket, task: LeadTask) {
  return `${task.instructions}\n\n---\n\nTask \`${task.key}\` of lead ticket #${lead.number}: ${lead.title}. ${
    task.land === 'branch'
      ? "This branch starts from the lead's branch. When this ticket finishes, the system merges it into the lead's branch."
      : 'This task opens its own pull request against the default branch; the lead decides whether the system merges it.'
  }`
}
