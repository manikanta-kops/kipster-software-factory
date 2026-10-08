import { runParallelFinal } from './parallel-final.ts'
import { runReviewAttempt } from './review.ts'
import { DependencyChangedError } from '../workspace/dependencies.ts'
import { dependencySession } from './dependencies.ts'
import { requestOtherRepository } from './ticket-links.ts'
import { agentFor, agentsFor, leadContext, leadResultProblem } from './tasks.ts'
import { getTaskOfChild, parkForTasks } from '../store/tasks.ts'
import { setArtifactHome } from '../store/database.ts'
import { cleanVerificationEvidence } from '../artifacts/storage.ts'
import { runDecision, type DecisionDependencies } from './decisions.ts'
import { maintainPullRequest } from './pull-requests.ts'
import { runProofAttempt } from './proof.ts'
import { loadKit, loadTrustedInstructions } from '../kit/kit.ts'
import {
  startVerification,
  VerificationError,
  verificationFinding,
} from '../verification/harness.ts'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AttemptConfig } from '../config.ts'
import { markRepositoryReady } from '../store/repositories.ts'
import type { Database } from '../store/database.ts'
import {
  addAttemptArtifacts,
  completeAttempt,
  getTicketDetail,
  recordAttemptHeadCommit,
  waitForPullRequestMerge,
  type AttemptContext,
} from '../store/tickets.ts'
import type { AgentExecutor } from '../executors/cli.ts'
import { run } from '../executors/process.ts'
import type { Workspaces } from '../workspace/workspaces.ts'
import type { GitHub } from '../github/github.ts'
import { buildPrompt, openSession, readResult } from './prompt.ts'

export interface RunnerOptions {
  database: Database
  home: string
  config: AttemptConfig
  workspaces: Workspaces
  github: GitHub
  decisions?: DecisionDependencies
  execute: AgentExecutor
  attemptAgents?: import('../domain/catalog.ts').AgentChoice[]
  parallelFinal?: boolean
  preparedSession?: {
    dependencies: readonly import('../workspace/dependencies.ts').DependencyCheckout[]
    execute: AgentExecutor
  }
  library?: import('../library/library.ts').Library
}
export async function runAttempt(
  options: RunnerOptions,
  context: AttemptContext,
  signal: AbortSignal,
): Promise<void> {
  setArtifactHome(options.database, options.home)
  try {
    if (context.step.kind === 'agent' && !options.attemptAgents) {
      const selections = await agentsFor(options, context, context.step.role)
      await addAttemptArtifacts(
        options.database,
        context.attempt.id,
        selections.notes,
      )
      options = { ...options, attemptAgents: selections.agents }
      context = {
        ...context,
        attempt: {
          ...context.attempt,
          agent: context.attempt.agent ?? selections.agents[0]!,
        },
      }
    }
    await executeAttempt(options, context, signal)
  } catch (error) {
    // Execution has stopped; keep a commit observation even when its result failed.
    const head = await run('git', ['rev-parse', 'HEAD'], {
      cwd: options.workspaces.path(context.ticket),
      signal: AbortSignal.timeout(5000),
    }).catch(() => null)
    if (head)
      await recordAttemptHeadCommit(options.database, context.attempt.id, head)
    throw error
  }
}
async function executeAttempt(
  options: RunnerOptions,
  context: AttemptContext,
  signal: AbortSignal,
): Promise<void> {
  const { database, home, workspaces } = options
  const { ticket, step, attempt } = context
  let { repository } = context
  const detail = await getTicketDetail(database, ticket.number)
  if (!detail) throw new Error(`Missing ticket #${ticket.number}`)
  signal.throwIfAborted()
  if (step.kind === 'system' && step.action === 'merge') {
    if (!detail.ticket.pullRequestUrl)
      throw new Error('Cannot wait for merge without a pull request')
    await waitForPullRequestMerge(database, attempt.id)
    return
  }
  const defaultBranch = await workspaces.prepareRepository(repository, signal)
  if (defaultBranch !== repository.defaultBranch)
    repository = await markRepositoryReady(database, repository.id, {
      defaultBranch,
    })
  const owned = await getTaskOfChild(database, ticket.id)
  // A branch task starts from, and is compared with, the lead's branch.
  const leadBase =
    owned?.task.land === 'branch'
      ? (owned.task.baseCommit ?? undefined)
      : undefined
  const cwd = await workspaces.prepare(ticket, repository, signal, leadBase)
  const git = (args: string[]) => run('git', args, { cwd, signal })
  const base = `origin/${repository.defaultBranch}`
  const diff = await git(['diff', '--stat', `${leadBase ?? base}...HEAD`])
  if (step.kind === 'system' && step.action === 'run-tasks') {
    await parkForTasks(database, attempt.id)
    return
  }
  if (step.kind === 'system' && step.action === 'decide') {
    await runDecision(options, { ...context, repository }, detail, cwd, signal)
    return
  }
  if (step.kind === 'system' && step.action === 'verify-kit') {
    const headCommit = await git(['rev-parse', 'HEAD'])
    let instance: Awaited<ReturnType<typeof startVerification>> | undefined
    try {
      const loaded = await loadKit(cwd, headCommit, signal)
      if (!loaded.kit?.verify)
        throw new VerificationError(
          'kit',
          loaded.state.error ?? 'Missing verify kit',
          [],
          '',
        )
      instance = await startVerification({
        home,
        ticketId: ticket.id,
        repository: cwd,
        commit: headCommit,
        kit: loaded.kit,
        database,
        signal,
        check: true,
      })
      await instance.stop()
      await completeAttempt(
        database,
        attempt.id,
        {
          outcome: 'passed',
          summary: 'Kit setup, check, start, readiness and cleanup passed.',
          artifacts: instance.logs,
        },
        { headCommit },
      )
    } catch (error) {
      if (signal.aborted) {
        const logs =
          error instanceof VerificationError
            ? error.logs
            : (instance?.logs ?? [])
        await addAttemptArtifacts(database, attempt.id, [
          ...logs,
          ...(error instanceof VerificationError
            ? [await verificationFinding(error)]
            : []),
        ])
        signal.throwIfAborted()
      }
      const failure =
        error instanceof VerificationError
          ? error
          : new VerificationError(
              'kit',
              error,
              instance?.logs ?? [],
              instance?.evidenceDir ?? '',
            )
      await completeAttempt(
        database,
        attempt.id,
        {
          outcome: 'failed',
          summary: failure.message,
          artifacts: [...failure.logs, await verificationFinding(failure)],
        },
        { headCommit },
      )
    } finally {
      await instance?.stop()
      if (instance) await cleanVerificationEvidence(home, instance.evidenceDir)
    }
    return
  }
  if (
    options.parallelFinal &&
    (await runParallelFinal(
      options,
      { ...context, repository },
      detail,
      cwd,
      diff,
      signal,
    ))
  )
    return
  if (step.kind === 'agent' && ['tester', 'reproducer'].includes(step.role)) {
    const verdict = await runProofAttempt(
      options,
      { ...context, repository },
      detail,
      cwd,
      diff,
      signal,
    )
    await completeAttempt(
      database,
      attempt.id,
      verdict.result,
      verdict.completion,
    )
    return
  }
  if (step.kind === 'agent' && step.role === 'reviewer') {
    const verdict = await runReviewAttempt(
      options,
      context,
      detail,
      cwd,
      diff,
      signal,
    )
    await completeAttempt(
      database,
      attempt.id,
      verdict.result,
      verdict.completion,
    )
    return
  }
  if (step.kind === 'agent') {
    const selected = await agentFor(options, context, step.role)
    const lead =
      step.role === 'lead'
        ? await leadContext(options, { ...context, repository }, detail)
        : undefined
    const before = await git(['rev-parse', 'HEAD'])
    const trusted = await loadTrustedInstructions(cwd, base, step.role, signal)
    let resultValidationError: string | undefined
    for (let retry = 0; retry < 2; retry++) {
      signal.throwIfAborted()
      const directory = join(
        home,
        'steps',
        String(ticket.id),
        String(attempt.id),
        String(retry + 1),
      )
      await mkdir(directory, { recursive: true })
      const session = await dependencySession(options, detail, signal)
      const prompt = await buildPrompt({
        database: options.database,
        dependencies: session.dependencies,
        step,
        detail,
        directory,
        diff,
        home,
        trusted,
        resultValidationError,
        ...(lead ? { lead } : {}),
      })
      const log = await openSession({
        database,
        home,
        ticketId: ticket.id,
        attemptId: attempt.id,
        directory,
        prompt,
        title: `${step.role} run ${retry + 1}`,
      })
      let executionError: unknown
      try {
        await session.execute({
          config: selected,
          cwd,
          prompt,
          directory,
          log,
          signal,
        })
      } catch (error) {
        executionError = error
      }
      if (executionError instanceof DependencyChangedError) throw executionError
      signal.throwIfAborted()
      let result
      try {
        result = await readResult(directory, step.role, home)
        const problem =
          step.role === 'lead'
            ? await leadResultProblem(options, context, result)
            : null
        if (problem) throw new Error(problem)
      } catch (error) {
        resultValidationError = String(error)
        await writeFile(
          join(directory, 'result-error.txt'),
          resultValidationError,
        )
        if (retry === 0) continue
        throw new Error(
          `Invalid or missing result.json after two runs: ${String(error)}`,
          { cause: error },
        )
      }
      if (executionError) throw executionError
      if (
        [
          'planner',
          'reviewer',
          'writer',
          'tester',
          'reproducer',
          'lead',
        ].includes(step.role)
      ) {
        if (
          (await git(['rev-parse', 'HEAD'])) !== before ||
          (await git(['status', '--porcelain']))
        )
          throw new Error(
            `${step.role} changed the worktree; preserved for human inspection`,
          )
      }
      if (
        step.role === 'builder' &&
        result.outcome === 'done' &&
        (await git(['status', '--porcelain']))
      )
        throw new Error('Builder left uncommitted changes')
      if (result.outcome === 'needs-other-repo') {
        await requestOtherRepository(
          options,
          attempt.id,
          result,
          await git(['rev-parse', 'HEAD']),
        )
        return
      }
      const artifacts = result.artifacts
      await completeAttempt(
        database,
        attempt.id,
        { ...result, artifacts },
        { headCommit: await git(['rev-parse', 'HEAD']) },
      )
      return
    }
  } else if (step.kind === 'system' && step.action === 'maintain-pr') {
    await maintainPullRequest(options, { ...context, repository }, cwd, signal)
  } else throw new Error(`Step ${step.id} is not supported in this slice`)
}
