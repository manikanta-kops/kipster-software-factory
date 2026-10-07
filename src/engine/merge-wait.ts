import { refreshMergeGate } from './merge-gate.ts'
import { pollAutoMerge } from './auto-merge.ts'
import {
  ciFailure,
  pollPullRequestBase,
  pollPullRequestFeedback,
} from './pull-requests.ts'
import { recordMergedPR } from '../store/post-merge.ts'
import { getMergeGate, invalidateMergeGate } from '../store/merge-gates.ts'
import { completeAttempt, type AttemptContext } from '../store/tickets.ts'
import { run } from '../executors/process.ts'
import type { RunnerOptions } from './runner.ts'

export async function pollMergeWait(
  options: RunnerOptions,
  context: AttemptContext,
  signal: AbortSignal,
) {
  if (!context.ticket.pullRequestUrl) return
  const pr = await options.github.inspect(
    context.repository.slug,
    context.ticket.pullRequestUrl,
    signal,
  )
  if (pr.state === 'OPEN') {
    const { gate, checks } = await refreshMergeGate(options, context, signal, {
      pr,
    })
    // Optional checks are not awaited, but one that fails after maintain-pr reported ready still needs the builder.
    if (checks.state === 'failed') {
      signal.throwIfAborted()
      await completeAttempt(
        options.database,
        context.attempt.id,
        { outcome: 'changes-needed', ...ciFailure(checks.failures) },
        { headCommit: gate.facts.head },
      )
      return
    }
    if (
      !(await pollPullRequestFeedback(options, context, signal)) &&
      !(await pollPullRequestBase(options, context, signal))
    )
      await pollAutoMerge(options, context, signal)
    return
  }
  let by: 'factory' | 'owner' = 'owner'
  if (pr.state === 'MERGED') {
    const snapshot = await getMergeGate(options.database, context.ticket.id)
    by = await recordMergedPR(
      options.database,
      context,
      pr,
      !!snapshot && snapshot.latest.facts.ci !== 'none',
    )
    await options.workspaces.prepareRepository(context.repository, signal)
  }
  try {
    await refreshMergeGate(options, context, signal, { pr })
  } catch (error) {
    await invalidateMergeGate(options.database, context.ticket.id, error)
  }
  const headCommit = await run('git', ['rev-parse', 'HEAD'], {
    cwd: options.workspaces.path(context.ticket),
    signal,
  }).catch(() => null)
  await completeAttempt(
    options.database,
    context.attempt.id,
    {
      outcome: pr.state === 'MERGED' ? 'merged' : 'rejected',
      summary:
        pr.state === 'MERGED'
          ? `Merged by ${by}: ${pr.url}`
          : `Pull request closed: ${pr.url}`,
      artifacts: [],
    },
    headCommit ? { headCommit } : {},
  )
}
