import { DependencyChangedError } from '../workspace/dependencies.ts'
import { dependencySession } from './dependencies.ts'
import { requestOtherRepository } from './ticket-links.ts'
import { setArtifactHome } from '../store/database.ts'
import {
  newEvidenceFile,
  cleanVerificationEvidence,
} from '../artifacts/storage.ts'
import { runDecision, type DecisionDependencies } from './decisions.ts'
import { maintainPullRequest } from './pull-requests.ts'
import { runProofAttempt } from './proof.ts'
import { loadKit } from '../kit/kit.ts'
import {
  startVerification,
  VerificationError,
  verificationFinding,
} from '../verification/harness.ts'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EngineConfig } from '../config.ts'
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
import { buildPrompt, readResult } from './prompt.ts'

export interface RunnerOptions {
  database: Database
  home: string
  config: EngineConfig
  workspaces: Workspaces
  github: GitHub
  decisions?: DecisionDependencies
  execute: AgentExecutor
  library?: import('../library/library.ts').Library
}
export async function runAttempt(
  options: RunnerOptions,
  context: AttemptContext,
  signal: AbortSignal,
): Promise<void> {
  setArtifactHome(options.database, options.home)
  try {
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
  const { database, home, config, workspaces } = options
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
  const cwd = await workspaces.prepare(ticket, repository, signal)
  const git = (args: string[]) => run('git', args, { cwd, signal })
  const base = `origin/${repository.defaultBranch}`
  const diff = await git(['diff', '--stat', `${base}...HEAD`])
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
  if (step.kind === 'agent' && ['tester', 'reproducer'].includes(step.role)) {
    await runProofAttempt(
      options,
      { ...context, repository },
      detail,
      cwd,
      diff,
      signal,
    )
    return
  }
  if (step.kind === 'agent') {
    const selected = config.agents.roles[step.role] ?? config.agents.default
    const before = await git(['rev-parse', 'HEAD'])
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
        dependencies: session.dependencies,
        step,
        detail,
        cwd,
        directory,
        diff,
        home,
      })
      await writeFile(join(directory, 'prompt.md'), prompt)
      const log = await newEvidenceFile(home, ticket.id)
      await writeFile(log, '')
      await addAttemptArtifacts(database, attempt.id, [
        { kind: 'log', title: `${step.role} run ${retry + 1}`, path: log },
      ])
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
      } catch (error) {
        await writeFile(join(directory, 'result-error.txt'), String(error))
        if (retry === 0) continue
        throw new Error(
          `Invalid or missing result.json after two runs: ${String(error)}`,
          { cause: error },
        )
      }
      if (executionError) throw executionError
      if (
        ['planner', 'reviewer', 'writer', 'tester', 'reproducer'].includes(
          step.role,
        )
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
