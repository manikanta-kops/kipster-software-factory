import { pollLinkedTickets } from './ticket-links.ts'
import { agentsFor, pollTasks } from './tasks.ts'
import { listTaskWaits } from '../store/tasks.ts'
import type { Library } from '../library/library.ts'
import { invalidateMergeGate } from '../store/merge-gates.ts'
import { AttemptMovedOn } from '../domain/errors.ts'
import { pruneEvidence, adoptEvidence } from '../store/evidence.ts'
import { pollMergeWait } from './merge-wait.ts'
import { checkAfterMerge } from './post-merge.ts'
import {
  pendingPostMergeChecks,
  markPostMergePolled,
} from '../store/post-merge.ts'
import type { DecisionDependencies } from './decisions.ts'
import type { LibraryEntry } from '../library/library.ts'
import { setArtifactHome } from '../store/database.ts'
import { pollPullRequestChecks } from './pull-requests.ts'
import {
  type AttemptConfig,
  engineConfig,
  type EngineConfig,
  settingsFromConfig,
} from '../config.ts'
import { type Settings, stepTimeoutFor } from '../domain/settings.ts'
import { effectiveSettings } from '../store/settings.ts'
import { executeAgent, type AgentExecutor } from '../executors/cli.ts'
import { github as realGitHub, type GitHub } from '../github/github.ts'
import type { Database } from '../store/database.ts'
import type { EventSignal } from '../store/events.ts'
import { acquireSchedulerLock } from '../store/scheduler.ts'
import {
  getRepositoryById,
  listRepositories,
  markRepositoryFailed,
  markRepositoryReady,
} from '../store/repositories.ts'
import {
  claimAttempts,
  failAttempt,
  getTicket,
  interruptRunning,
  listTickets,
  listWaitingForMerge,
  markRunning,
  addAttemptArtifacts,
  markWorktreeCleaned,
  type AttemptContext,
} from '../store/tickets.ts'
import { Workspaces } from '../workspace/workspaces.ts'
import { runAttempt } from './runner.ts'

export interface SchedulerOptions {
  database: Database
  events: EventSignal
  home: string
  library?: Library
  config?: EngineConfig
  execute?: AgentExecutor
  github?: GitHub
  fallbackMs?: number
  mergePollMs?: number
  decisions?: DecisionDependencies
  bugWorkflow?: LibraryEntry
  onError?: (error: unknown) => void
}
export async function startScheduler(
  options: SchedulerOptions,
): Promise<{ close(): Promise<void> }> {
  const { database, events } = options
  setArtifactHome(database, options.home)
  const config = engineConfig.parse(options.config ?? {})
  const fallback = settingsFromConfig(config)
  const workspaces = new Workspaces(
    options.home,
    (repository, defaultBranch, kit) =>
      markRepositoryReady(database, repository.id, { defaultBranch, kit }),
  )
  const github = options.github ?? realGitHub
  const runnerOptions = {
    database,
    home: workspaces.home,
    config,
    workspaces,
    github,
    execute: options.execute ?? executeAgent,
    ...(options.decisions ? { decisions: options.decisions } : {}),
    ...(options.library ? { library: options.library } : {}),
  }
  const report =
    options.onError ?? ((error: unknown) => console.error('Scheduler:', error))
  const lifetime = new AbortController()
  const active = new Map<
    number,
    {
      context: AttemptContext
      controller: AbortController
      done: Promise<void>
    }
  >()
  const postMergeJobs = new Map<string, Promise<void>>()
  const mergeJobs = new Map<number, Promise<void>>()
  const taskJobs = new Map<number, Promise<void>>()
  let stopped = false
  let ticking: Promise<void> | undefined
  let requested = false
  let nextMergePoll = 0
  let nextPrune = 0
  let pruning: Promise<unknown> | undefined
  const lock = await acquireSchedulerLock(database, (error) => {
    report(
      new Error(
        `Scheduler lock connection lost; stopping all work: ${error.message}`,
      ),
    )
    stopped = true
    lifetime.abort(error)
    for (const item of active.values()) item.controller.abort(error)
  })
  try {
    await interruptRunning(database)
  } catch (error) {
    await lock.close()
    throw error
  }

  // A step keeps the settings it started with; later saves apply to later steps.
  async function run(
    context: AttemptContext,
    controller: AbortController,
    settings: Settings,
  ) {
    const { attempt, ticket, step } = context
    const attemptConfig: AttemptConfig = { ...config, ...settings }
    const minutes = stepTimeoutFor(settings, context.workflow.name)
    const timer = setTimeout(
      () =>
        controller.abort(new Error(`Step timed out after ${minutes} minutes`)),
      minutes * 60_000,
    )
    try {
      controller.signal.throwIfAborted()
      const selections =
        step.kind === 'agent'
          ? await agentsFor(
              { database, config: attemptConfig },
              context,
              step.role,
            )
          : { agents: [], notes: [] }
      const agent = selections.agents[0] ?? null
      const running = await markRunning(
        database,
        attempt.id,
        agent?.cli ?? 'system',
        agent,
      )
      if (selections.notes.length)
        await addAttemptArtifacts(database, attempt.id, selections.notes)
      await runAttempt(
        {
          ...runnerOptions,
          config: attemptConfig,
          attemptAgents: selections.agents,
        },
        { ...context, attempt: running },
        controller.signal,
      )
    } catch (error) {
      if (!stopped) {
        const current = await getTicket(database, ticket.number)
        if (current?.status === 'running') {
          try {
            await failAttempt(database, attempt.id, String(error))
          } catch (failure) {
            report(failure)
          }
        }
      }
    } finally {
      clearTimeout(timer)
      active.delete(attempt.id)
      wake()
    }
  }
  async function checkCancellations() {
    for (const item of active.values()) {
      const current = await getTicket(database, item.context.ticket.number)
      if (current?.status === 'cancelled')
        item.controller.abort(new Error('Ticket cancelled'))
    }
  }
  async function tick() {
    await checkCancellations()
    if (stopped) return
    const { settings } = await effectiveSettings(database, fallback)
    const polling = { ...runnerOptions, config: { ...config, ...settings } }
    if (!pruning && Date.now() >= nextPrune) {
      nextPrune = Date.now() + 60 * 60_000
      pruning = adoptEvidence(database, options.home)
        .then(() =>
          pruneEvidence(database, options.home, config.evidenceRetentionDays),
        )
        .catch(report)
        .finally(() => {
          pruning = undefined
        })
    }
    const capacity = settings.concurrency - active.size
    if (capacity > 0) {
      for (const context of await claimAttempts(database, capacity)) {
        if (stopped) break
        const controller = new AbortController()
        const done = run(context, controller, settings).catch(report)
        active.set(context.attempt.id, { context, controller, done })
      }
    }
    // Every tick, so a finished child reaches its lead without waiting for the merge poll.
    for (const wait of await listTaskWaits(database)) {
      if (stopped) return
      if (taskJobs.has(wait.attemptId)) continue
      const job = pollTasks(
        polling,
        wait,
        AbortSignal.any([lifetime.signal, AbortSignal.timeout(300_000)]),
      )
        .catch((error) => {
          if (!stopped && !(error instanceof AttemptMovedOn)) report(error)
        })
        .finally(() => {
          taskJobs.delete(wait.attemptId)
        })
      taskJobs.set(wait.attemptId, job)
    }
    if (Date.now() >= nextMergePoll) {
      nextMergePoll = Date.now() + (options.mergePollMs ?? 60_000)
      await pollLinkedTickets(
        polling,
        AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]),
        report,
      ).catch(report)
      for (const context of await listWaitingForMerge(
        database,
        'pull-request-checks',
      )) {
        if (stopped) return
        if (active.has(context.attempt.id)) continue
        try {
          await pollPullRequestChecks(
            polling,
            context,
            AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]),
          )
        } catch (error) {
          if (!stopped && !(error instanceof AttemptMovedOn)) {
            await invalidateMergeGate(database, context.ticket.id, error)
            report(error)
          }
        }
      }
      for (const context of await listWaitingForMerge(database)) {
        if (stopped) return
        if (mergeJobs.has(context.attempt.id)) continue
        const job = pollMergeWait(
          polling,
          context,
          AbortSignal.any([lifetime.signal, AbortSignal.timeout(60_000)]),
        )
          .catch(async (error) => {
            if (!stopped && !(error instanceof AttemptMovedOn)) {
              report(error)
              try {
                await invalidateMergeGate(database, context.ticket.id, error)
              } catch (invalidationError) {
                report(invalidationError)
              }
            }
          })
          .finally(() => {
            mergeJobs.delete(context.attempt.id)
          })
        mergeJobs.set(context.attempt.id, job)
      }
      for (const check of await pendingPostMergeChecks(database)) {
        if (stopped) return
        if (postMergeJobs.size >= 2) break
        const key = `${check.repositoryId}:${check.mergeCommit}`
        if (postMergeJobs.has(key)) continue
        await markPostMergePolled(database, check)
        const job = checkAfterMerge(
          polling,
          check,
          AbortSignal.any([
            lifetime.signal,
            AbortSignal.timeout(settings.stepTimeoutMinutes * 60_000),
          ]),
          options.bugWorkflow,
        )
          .catch((error) => {
            if (!stopped) report(error)
          })
          .finally(() => {
            postMergeJobs.delete(key)
          })
        postMergeJobs.set(key, job)
      }
    }
    for (const repository of await listRepositories(database, {
      status: 'pending',
    })) {
      if (stopped) return
      try {
        const defaultBranch = await workspaces.prepareRepository(
          repository,
          AbortSignal.any([lifetime.signal, AbortSignal.timeout(300_000)]),
        )
        if (!stopped)
          await markRepositoryReady(database, repository.id, { defaultBranch })
      } catch (error) {
        if (!stopped)
          await markRepositoryFailed(database, repository.id, String(error))
      }
    }
    for (const ticket of await listTickets(database, {
      status: ['done', 'cancelled'],
      cleanupPending: true,
    })) {
      if (stopped) return
      if (
        [...active.values()].some(
          (item) => item.context.ticket.id === ticket.id,
        )
      )
        continue
      const repository = await getRepositoryById(database, ticket.repository.id)
      if (repository) {
        try {
          if (await workspaces.cleanup(ticket, repository, lifetime.signal))
            await markWorktreeCleaned(database, ticket.id)
        } catch (error) {
          if (!stopped) report(error)
        }
      }
    }
  }
  function wake() {
    if (stopped) return
    requested = true
    if (ticking) return
    ticking = (async () => {
      while (requested) {
        if (stopped) break
        requested = false
        await tick()
      }
    })()
      .catch(report)
      .finally(() => {
        ticking = undefined
        if (requested) wake()
      })
  }
  // Cancellation must not wait behind a slow clone, fetch or GitHub poll.
  let checking: Promise<void> | undefined
  const notified = () => {
    if (!stopped && !checking)
      checking = checkCancellations()
        .catch(report)
        .finally(() => {
          checking = undefined
        })
    wake()
  }
  const unsubscribe = events.subscribe(notified)
  const timer = setInterval(notified, options.fallbackMs ?? 15_000)
  wake()
  let closing: Promise<void> | undefined
  return {
    close() {
      return (closing ??= (async () => {
        const held = !stopped
        stopped = true
        unsubscribe()
        clearInterval(timer)
        lifetime.abort(new Error('Factory shutting down'))
        for (const item of active.values())
          item.controller.abort(new Error('Factory shutting down'))
        await ticking
        await checking
        await pruning
        await Promise.all([
          ...mergeJobs.values(),
          ...postMergeJobs.values(),
          ...taskJobs.values(),
        ])
        await Promise.all([...active.values()].map((item) => item.done))
        try {
          if (held) await interruptRunning(database)
        } finally {
          await lock.close()
        }
      })())
    },
  }
}
