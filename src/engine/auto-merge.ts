import { mergePolicy } from '../domain/auto-merge.ts'
import { refreshMergeGate } from './merge-gate.ts'
import { markMergeRequested, markMergeResult } from '../store/auto-merge.ts'
import { getRepositoryById } from '../store/repositories.ts'
import { getTaskOfChild } from '../store/tasks.ts'
import type { AttemptContext } from '../store/tickets.ts'
import type { RunnerOptions } from './runner.ts'

export async function pollAutoMerge(
  options: RunnerOptions,
  context: AttemptContext,
  signal: AbortSignal,
) {
  // A lead's pull request task merges only after the lead says so.
  const owned = await getTaskOfChild(options.database, context.ticket.id)
  if (owned?.task.land === 'pr' && owned.task.decision !== 'merge') return
  const { gate } = await refreshMergeGate(options, context, signal)
  const repository = await getRepositoryById(
    options.database,
    context.repository.id,
  )
  if (mergePolicy(!!repository?.autoMerge, gate) !== 'merge') return
  const head = gate.facts.head
  // Re-read Git, GitHub and verdicts immediately before the head-matched mutation.
  const fresh = await refreshMergeGate(options, context, signal)
  const currentRepository = await getRepositoryById(
    options.database,
    context.repository.id,
  )
  if (
    fresh.gate.facts.head !== head ||
    mergePolicy(!!currentRepository?.autoMerge, fresh.gate) !== 'merge'
  )
    return
  signal.throwIfAborted()
  if (!(await markMergeRequested(options.database, context, fresh.gate))) return
  try {
    await options.github.merge(
      context.repository.slug,
      context.ticket.pullRequestUrl!,
      head,
      signal,
    )
    await markMergeResult(options.database, context.ticket.id, head)
  } catch (error) {
    // GitHub may have merged despite a lost response. The next poll reconciles the request.
    await markMergeResult(
      options.database,
      context.ticket.id,
      head,
      String(error),
    )
    signal.throwIfAborted()
  }
}
