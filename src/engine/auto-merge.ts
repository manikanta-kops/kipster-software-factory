import { mergePolicy, mergeQuestion } from '../domain/auto-merge.ts'
import { buildDecisionFacts } from './decision-facts.ts'
import { askDecision } from './decisions.ts'
import { refreshMergeGate } from './merge-gate.ts'
import {
  mergeDecision,
  reserveMergeDecision,
  saveMergeDecision,
  markMergeRequested,
  markMergeResult,
} from '../store/auto-merge.ts'
import { getRepositoryById } from '../store/repositories.ts'
import { getTicketDetail, type AttemptContext } from '../store/tickets.ts'
import type { RunnerOptions } from './runner.ts'

export async function pollAutoMerge(
  options: RunnerOptions,
  context: AttemptContext,
  signal: AbortSignal,
) {
  const { gate } = await refreshMergeGate(options, context, signal)
  const repository = await getRepositoryById(
    options.database,
    context.repository.id,
  )
  let decision = await mergeDecision(
    options.database,
    context.ticket.id,
    gate.facts.head,
  )
  if (mergePolicy(!!repository?.autoMerge, gate, decision) === 'ask') {
    const detail = (await getTicketDetail(
      options.database,
      context.ticket.number,
    ))!
    const observed = await buildDecisionFacts(
      detail,
      options.workspaces.path(context.ticket),
      context.repository.defaultBranch,
      signal,
      { commit: gate.facts.head, state: gate.facts.ci },
    )
    if (
      observed.headCommit !== gate.facts.head ||
      observed.base.commit !== gate.facts.base
    )
      return
    const { ticket: _ticket, ...facts } = observed
    const input = {
      ...mergeQuestion,
      facts: {
        ...facts,
        verdicts: facts.verdicts.filter(
          (verdict) => verdict.commit === gate.facts.head,
        ),
        gate: gate.facts,
      },
      answer: null,
      band: 'error' as const,
      reason: 'Decision request interrupted; owner review required.',
      durationMs: 0,
    }
    const id = await reserveMergeDecision(
      options.database,
      context.ticket.id,
      context.attempt.id,
      input,
    )
    if (!id) return
    await saveMergeDecision(
      options.database,
      id,
      await askDecision(options, input.facts, mergeQuestion, signal),
    )
    decision = await mergeDecision(
      options.database,
      context.ticket.id,
      gate.facts.head,
    )
  }
  if (
    mergePolicy(!!repository?.autoMerge, gate, decision) !== 'merge' ||
    !decision
  )
    return
  // Every merge authorization is checked against fresh Git, GitHub and store facts.
  const fresh = await refreshMergeGate(options, context, signal)
  const currentRepository = await getRepositoryById(
    options.database,
    context.repository.id,
  )
  if (
    fresh.gate.facts.head !== decision.facts.headCommit ||
    mergePolicy(!!currentRepository?.autoMerge, fresh.gate, decision) !==
      'merge'
  )
    return
  signal.throwIfAborted()
  if (!(await markMergeRequested(options.database, decision.id))) return
  try {
    await options.github.merge(
      context.repository.slug,
      context.ticket.pullRequestUrl!,
      decision.facts.headCommit,
      signal,
    )
    await markMergeResult(options.database, decision.id)
  } catch {
    await markMergeResult(
      options.database,
      decision.id,
      'Factory merge could not complete; inspect the PR and merge as owner.',
    )
    signal.throwIfAborted()
  }
}
