import { decideParams } from '../domain/catalog.ts'
import { decisionBand } from '../domain/decisions.ts'
import {
  askTypeSafe,
  typeSafeError,
  type DecisionTransport,
} from '../decider/typesafe.ts'
import { secretStore, type Secrets } from '../secrets/store.ts'
import {
  recordDecisionOutcome,
  type AttemptContext,
  type TicketDetail,
} from '../store/tickets.ts'
import type { RunnerOptions } from './runner.ts'
import { buildDecisionFacts } from './decision-facts.ts'

export interface DecisionDependencies {
  secrets?: Pick<Secrets, 'get'>
  transport?: DecisionTransport
}
export async function runDecision(
  options: RunnerOptions,
  context: AttemptContext,
  detail: TicketDetail,
  cwd: string,
  signal: AbortSignal,
): Promise<void> {
  if (context.step.kind !== 'system' || context.step.action !== 'decide')
    throw new Error('Expected decide step')
  const params = decideParams.parse(context.step.with)
  let facts = await buildDecisionFacts(
    detail,
    cwd,
    context.repository.defaultBranch,
    signal,
  )
  if (detail.ticket.pullRequestUrl) {
    try {
      const checks = await options.github.checks(
        context.repository.slug,
        detail.ticket.pullRequestUrl,
        facts.headCommit,
        signal,
      )
      facts = {
        ...facts,
        ci: { commit: facts.headCommit, state: checks.state },
      }
    } catch {
      signal.throwIfAborted()
    }
  }
  const started = Date.now()
  let answer = null
  let band: 'acted' | 'confirm' | 'owner' | 'no-key' | 'error' = 'no-key'
  let reason: string | null = 'No TypeSafe key: run kf secret set typesafe'
  let key: string | null = null
  try {
    // An OS credential prompt can block indefinitely; the owner decides instead.
    key = await (options.decisions?.secrets ?? secretStore(options.home)).get(
      'typesafe',
      AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    )
  } catch {
    signal.throwIfAborted()
    band = 'error'
    reason = 'Cannot read the typesafe secret from the credential store'
  }
  try {
    if (key) {
      answer = await askTypeSafe(
        key,
        facts,
        params.question,
        params.options,
        signal,
        options.decisions?.transport,
      )
      band = decisionBand(answer.confidence, params.bands)
      reason = null
    }
  } catch (error) {
    signal.throwIfAborted()
    band = 'error'
    reason = typeSafeError(error)
  }
  signal.throwIfAborted()
  await recordDecisionOutcome(options.database, context.attempt.id, {
    ...params,
    facts,
    answer,
    band,
    reason,
    durationMs: Date.now() - started,
  })
}
