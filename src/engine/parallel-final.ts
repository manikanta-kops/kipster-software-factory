import type { StepResult } from '../domain/lifecycle.ts'
import { parallelReviewer } from '../domain/parallel-final.ts'
import { run } from '../executors/process.ts'
import {
  addAttemptArtifacts,
  completeParallelAttempts,
  startParallelReview,
  type AttemptContext,
  type TicketDetail,
} from '../store/tickets.ts'
import { dependencySession } from './dependencies.ts'
import { runProofAttempt } from './proof.ts'
import { runReviewAttempt } from './review.ts'
import type { RunnerOptions } from './runner.ts'
import { agentsFor } from './tasks.ts'

export interface Verdict {
  result: StepResult
  completion: { headCommit: string; reproductionAttemptId?: number }
}

export async function runParallelFinal(
  options: RunnerOptions,
  context: AttemptContext,
  detail: TicketDetail,
  cwd: string,
  diff: string,
  signal: AbortSignal,
): Promise<boolean> {
  const step = parallelReviewer(context.workflow, context.step)
  if (!step) return false
  const head = await run('git', ['rev-parse', 'HEAD'], { cwd, signal })
  const reviewerContext = { ...context, step }
  const selections = await agentsFor(options, reviewerContext, 'reviewer')
  const attempt = await startParallelReview(
    options.database,
    context.attempt.id,
    selections.agents[0]!,
    head,
  )
  await addAttemptArtifacts(options.database, attempt.id, selections.notes)
  const preparedSession = await dependencySession(options, detail, signal)
  const pairedOptions = { ...options, preparedSession }
  const results = await Promise.allSettled([
    runProofAttempt(pairedOptions, context, detail, cwd, diff, signal),
    runReviewAttempt(
      { ...pairedOptions, attemptAgents: selections.agents },
      { ...reviewerContext, attempt },
      detail,
      cwd,
      diff,
      signal,
    ),
  ])
  // Keep the join even on execution failures; never route while a sibling is still running.
  for (let index = 0; index < results.length; index++) {
    const result = results[index]!
    if (result.status === 'fulfilled')
      await addAttemptArtifacts(
        options.database,
        index === 0 ? context.attempt.id : attempt.id,
        result.value.result.artifacts,
      )
  }
  const failed = results.find((result) => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
  const tested = results[0]!
  const reviewed = results[1]!
  if (tested.status !== 'fulfilled' || reviewed.status !== 'fulfilled')
    throw new Error('Missing paired verdict')
  signal.throwIfAborted()
  if (
    (await run('git', ['rev-parse', 'HEAD'], { cwd, signal })) !== head ||
    tested.value.completion.headCommit !== head ||
    reviewed.value.completion.headCommit !== head
  )
    throw new Error(
      'Ticket branch moved during final checks; verdicts are stale',
    )
  await completeParallelAttempts(
    options.database,
    context.attempt.id,
    attempt.id,
    { ...tested.value, result: { ...tested.value.result, artifacts: [] } },
    { ...reviewed.value, result: { ...reviewed.value.result, artifacts: [] } },
  )
  return true
}
