import { DependencyChangedError } from '../workspace/dependencies.ts'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ArtifactInput, StepResult } from '../domain/lifecycle.ts'
import { findingTitle, reviewHistory } from '../domain/review.ts'
import { describeAgent } from '../domain/settings.ts'
import { run } from '../executors/process.ts'
import { loadTrustedInstructions } from '../kit/kit.ts'
import {
  addAttemptArtifacts,
  type AttemptContext,
  type TicketDetail,
} from '../store/tickets.ts'
import { dependencySession } from './dependencies.ts'
import {
  agentResultError,
  buildPrompt,
  openSession,
  readResult,
  recordSessionUsage,
} from './prompt.ts'
import type { RunnerOptions } from './runner.ts'
import type { Verdict } from './parallel-final.ts'

export async function runReviewAttempt(
  options: RunnerOptions,
  context: AttemptContext,
  detail: TicketDetail,
  cwd: string,
  diff: string,
  signal: AbortSignal,
): Promise<Verdict> {
  const { step, ticket, attempt, repository } = context
  if (step.kind !== 'agent') throw new Error('Review requires an agent step')
  const git = (args: string[]) => run('git', args, { cwd, signal })
  const head = await git(['rev-parse', 'HEAD'])
  const trusted = await loadTrustedInstructions(
    cwd,
    `origin/${repository.defaultBranch}`,
    'reviewer',
    signal,
  )
  const isLead = context.workflow.steps.some(
    (s) => s.kind === 'agent' && s.role === 'lead',
  )
  const history = reviewHistory(detail, step.id)
  const changed =
    isLead && history.round > 1 && history.firstCommit
      ? new Set(
          (
            await git([
              'diff',
              '--no-renames',
              '--name-only',
              '-z',
              history.firstCommit,
              head,
            ])
          )
            .split('\0')
            .filter(Boolean),
        )
      : null
  // Prepare dependency checkouts once; parallel sessions judge the same pinned contents.
  const session = await dependencySession(options, detail, signal)
  const agents = options.attemptAgents ?? [attempt.agent!]
  const results = await Promise.allSettled(
    agents.map(async (agent, index): Promise<StepResult> => {
      let resultValidationError: string | undefined
      for (let retry = 1; retry <= 2; retry++) {
        signal.throwIfAborted()
        const directory = join(
          options.home,
          'steps',
          String(ticket.id),
          String(attempt.id),
          String(retry),
          String(index),
        )
        await mkdir(directory, { recursive: true })
        const prompt = await buildPrompt({
          database: options.database,
          dependencies: session.dependencies,
          step,
          detail,
          directory,
          headCommit: head,
          diff,
          home: options.home,
          trusted,
          resultValidationError,
        })
        const log = await openSession({
          database: options.database,
          home: options.home,
          ticketId: ticket.id,
          attemptId: attempt.id,
          directory,
          prompt,
          title: `Reviewer ${index + 1} (${describeAgent(agent)}) run ${retry}`,
        })
        let executionError: unknown
        try {
          await session.execute({
            config: agent,
            cwd,
            prompt,
            directory,
            log,
            signal,
          })
        } catch (error) {
          executionError = error
        }
        await recordSessionUsage(options.database, attempt.id, agent.cli, log)
        signal.throwIfAborted()
        if (
          (await git(['rev-parse', 'HEAD'])) !== head ||
          (await git(['status', '--porcelain']))
        )
          throw new Error(
            'reviewer changed the worktree; preserved for human inspection',
          )
        if (executionError instanceof DependencyChangedError)
          throw executionError
        let result: StepResult
        try {
          result = await readResult(directory, 'reviewer', options.home)
        } catch (error) {
          const failure = await agentResultError(
            error,
            executionError,
            log,
            retry === 1
              ? 'Invalid or missing result.json'
              : 'Invalid or missing result.json after two runs',
          )
          resultValidationError = failure.message
          await writeFile(
            join(directory, 'result-error.txt'),
            resultValidationError,
          )
          if (retry === 1) continue
          throw failure
        }
        if (executionError) throw executionError
        const artifacts: ArtifactInput[] = result.artifacts.map((artifact) => {
          const earlier = history.findings.some(
            (finding) =>
              findingTitle(finding.title) === artifact.title &&
              (finding.file ?? null) === (artifact.file ?? null),
          )
          const downgraded =
            artifact.kind === 'finding' &&
            changed &&
            artifact.file &&
            !changed.has(artifact.file) &&
            !earlier
          return {
            ...artifact,
            kind: downgraded ? 'note' : artifact.kind,
            title: `[${describeAgent(agent)}] ${artifact.title}`.slice(0, 200),
            ...(downgraded && artifact.content !== undefined
              ? {
                  content: `New finding downgraded: ${artifact.file} is unchanged since round 1 (${history.firstCommit}).\n\n${artifact.content ?? ''}`,
                  path: undefined,
                }
              : {}),
          }
        })
        const serious = artifacts.some(
          (artifact) => artifact.kind === 'finding',
        )
        const onlyDowngraded =
          result.outcome === 'changes-needed' &&
          result.artifacts.some((artifact) => artifact.kind === 'finding') &&
          !serious
        const outcome = serious
          ? 'changes-needed'
          : onlyDowngraded
            ? 'passed'
            : result.outcome
        if (result.ownerReview)
          artifacts.push({
            kind: 'note',
            title: `[${describeAgent(agent)}] Owner review requested`.slice(
              0,
              200,
            ),
            content: result.ownerReview.reason,
          })
        artifacts.push({
          kind: 'note',
          title: `[${describeAgent(agent)}] Reviewer verdict`.slice(0, 200),
          content: `Reviewed ${head}: ${outcome}.\n\n${result.summary}`,
        })
        return { ...result, outcome, artifacts }
      }
      throw new Error('Reviewer did not produce a result')
    }),
  )
  const fulfilled = results.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  )
  const artifacts = fulfilled.flatMap((result) => result.artifacts)
  const failure = results.find((result) => result.status === 'rejected')
  if (failure?.status === 'rejected') {
    await addAttemptArtifacts(options.database, attempt.id, artifacts)
    throw failure.reason
  }
  if (
    (await git(['rev-parse', 'HEAD'])) !== head ||
    (await git(['status', '--porcelain']))
  )
    throw new Error(
      'reviewer changed the worktree; preserved for human inspection',
    )
  const passed = fulfilled.every((result) => result.outcome === 'passed')
  const outcome =
    !isLead && fulfilled.length === 1
      ? fulfilled[0]!.outcome
      : passed
        ? 'passed'
        : 'changes-needed'
  const ownerReasons = fulfilled.flatMap((result) =>
    result.ownerReview ? [result.ownerReview.reason] : [],
  )
  return {
    result: {
      outcome,
      summary:
        !isLead && fulfilled.length === 1
          ? fulfilled[0]!.summary
          : fulfilled
              .map(
                (result, index) =>
                  `${describeAgent(agents[index]!)}: ${result.summary}`,
              )
              .join('\n\n'),
      artifacts,
      ...(passed && ownerReasons.length
        ? { ownerReview: { reason: ownerReasons.join('; ').slice(0, 1000) } }
        : {}),
    },
    completion: { headCommit: head },
  }
}
