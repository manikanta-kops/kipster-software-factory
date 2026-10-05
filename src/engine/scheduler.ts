import { pollLinkedTickets } from './ticket-links.ts'
import type { Library } from '../library/library.ts'
import { invalidateMergeGate } from '../store/merge-gates.ts'
import { pruneEvidence, adoptEvidence } from '../store/evidence.ts'
import { refreshMergeGate } from './merge-gate.ts'
import { setArtifactHome } from '../store/database.ts'
import {
  pollPullRequestChecks,
  pollPullRequestBase,
  pollPullRequestFeedback,
} from './pull-requests.ts'
import { run as runProcess } from '../executors/process.ts'
import { engineConfig, type EngineConfig } from '../config.ts'
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
  completeAttempt,
  failAttempt,
  getTicket,
  interruptRunning,
  listTickets,
  listWaitingForMerge,
  markRunning,
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
  onError?: (error: unknown) => void
}
export async function startScheduler(
  options: SchedulerOptions,
): Promise<{ close(): Promise<void> }> {
  const { database, events } = options
  setArtifactHome(database, options.home)
  const config = engineConfig.parse(options.config ?? {})
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

  async function run(context: AttemptContext, controller: AbortController) {
    const { attempt, ticket, step } = context
    const timer = setTimeout(
      () =>
        controller.abort(
          new Error(
            `Step timed out after ${config.stepTimeoutMinutes} minutes`,
          ),
        ),
      config.stepTimeoutMinutes * 60_000,
    )
    try {
      controller.signal.throwIfAborted()
      await markRunning(
        database,
        attempt.id,
        step.kind === 'agent'
          ? (config.agents.roles[step.role] ?? config.agents.default).cli
          : 'system',
      )
      await runAttempt(
        {
          ...(options.library ? { library: options.library } : {}),
          database,
          home: workspaces.home,
          config,
          workspaces,
          github,
          execute: options.execute ?? executeAgent,
        },
        context,
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
    const capacity = config.concurrency - active.size
    if (capacity > 0) {
      for (const context of await claimAttempts(database, capacity)) {
        if (stopped) break
        const controller = new AbortController()
        const done = run(context, controller).catch(report)
        active.set(context.attempt.id, { context, controller, done })
      }
    }
    await pollLinkedTickets(
      runnerOptions,
      AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]),
      report,
    ).catch(report)
    if (Date.now() >= nextMergePoll) {
      nextMergePoll = Date.now() + (options.mergePollMs ?? 60_000)
      for (const context of await listWaitingForMerge(
        database,
        'pull-request-checks',
      )) {
        if (stopped) return
        if (active.has(context.attempt.id)) continue
        try {
          await pollPullRequestChecks(
            runnerOptions,
            context,
            AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]),
          )
        } catch (error) {
          if (!stopped) {
            await invalidateMergeGate(database, context.ticket.id, error)
            report(error)
          }
        }
      }
      for (const context of await listWaitingForMerge(database)) {
        if (stopped) return
        try {
          if (!context.ticket.pullRequestUrl) continue
          const pr = await github.inspect(
            context.repository.slug,
            context.ticket.pullRequestUrl,
            AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]),
          )
          try {
            await refreshMergeGate(
              runnerOptions,
              context,
              AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]),
              { pr },
            )
          } catch (error) {
            await invalidateMergeGate(database, context.ticket.id, error)
            if (pr.state === 'OPEN') throw error
            report(error)
          }
          if (pr.state === 'OPEN') {
            const feedback = await pollPullRequestFeedback(
              runnerOptions,
              context,
              AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]),
            )
            if (!feedback)
              await pollPullRequestBase(
                runnerOptions,
                context,
                AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]),
              )
          } else {
            const signal = AbortSignal.any([
              lifetime.signal,
              AbortSignal.timeout(30_000),
            ])
            if (pr.state === 'MERGED')
              await workspaces.prepareRepository(context.repository, signal)
            const headCommit = await runProcess('git', ['rev-parse', 'HEAD'], {
              cwd: workspaces.path(context.ticket),
              signal,
            }).catch(() => null)
            await completeAttempt(
              database,
              context.attempt.id,
              {
                outcome: pr.state === 'MERGED' ? 'merged' : 'rejected',
                summary: `Pull request ${pr.state.toLowerCase()}: ${pr.url}`,
                artifacts: [],
              },
              headCommit ? { headCommit } : {},
            )
          }
        } catch (error) {
          if (!stopped) {
            await invalidateMergeGate(database, context.ticket.id, error)
            report(error)
          }
        }
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
