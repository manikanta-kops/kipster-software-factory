import type { DecisionFacts } from '../domain/decisions.ts'
import { run } from '../executors/process.ts'
import type { TicketDetail } from '../store/tickets.ts'

/** Facts observed by the factory; agent prose never enters a decision state. */
export async function buildDecisionFacts(
  detail: TicketDetail,
  cwd: string,
  defaultBranch: string,
  signal: AbortSignal,
  ci: DecisionFacts['ci'] = null,
): Promise<DecisionFacts> {
  const git = (args: string[]) => run('git', args, { cwd, signal })
  const ref = `origin/${defaultBranch}`
  const [baseCommit, headCommit, numstat] = await Promise.all([
    git(['rev-parse', ref]),
    git(['rev-parse', 'HEAD']),
    git(['diff', '--numstat', '-z', '--no-renames', `${ref}...HEAD`]),
  ])
  const files = numstat
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const first = line.indexOf('\t'),
        second = line.indexOf('\t', first + 1)
      return {
        path: line.slice(second + 1),
        added:
          line.slice(0, first) === '-' ? null : Number(line.slice(0, first)),
        removed:
          line.slice(first + 1, second) === '-'
            ? null
            : Number(line.slice(first + 1, second)),
      }
    })
  const latest = new Map<string, DecisionFacts['verdicts'][number]>()
  for (const attempt of detail.attempts) {
    const step = detail.workflow.steps.find(
      (candidate) => candidate.id === attempt.stepId,
    )
    if (
      step?.kind !== 'agent' ||
      !['tester', 'reproducer', 'reviewer'].includes(step.role) ||
      attempt.waitingFor === 'ask'
    )
      continue
    latest.set(step.id, {
      attemptId: attempt.id,
      stepId: attempt.stepId,
      role: step.role,
      status: attempt.status,
      outcome: attempt.outcome,
      commit: attempt.headCommit,
    })
  }
  return {
    ticket: { title: detail.ticket.title, body: detail.ticket.body },
    base: { ref, commit: baseCommit },
    headCommit,
    files,
    verdicts: [...latest.values()],
    ci,
  }
}
