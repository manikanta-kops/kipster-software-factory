import { evaluateMergeGate, type VerdictFact } from '../domain/merge-gate.ts'
import type { TicketDetail, AttemptContext } from '../store/tickets.ts'
import { getTicketDetail } from '../store/tickets.ts'
import { saveMergeGate } from '../store/merge-gates.ts'
import { loadKit } from '../kit/kit.ts'
import { run } from '../executors/process.ts'
import type { RunnerOptions } from './runner.ts'
import type { PullRequest } from '../github/github.ts'
import type { Checks } from '../github/checks.ts'
import type { PullRequestFeedback } from '../github/feedback.ts'

export function freshFeedback(
  detail: TicketDetail,
  feedback: readonly PullRequestFeedback[],
) {
  return feedback.filter(
    (f) =>
      Date.parse(f.createdAt) >= Date.parse(detail.ticket.createdAt) &&
      !detail.artifacts.some(
        (a) =>
          a.kind === 'comment' &&
          a.content?.includes(`<!-- github-feedback:${f.id} -->`),
      ),
  )
}
export async function refreshMergeGate(
  options: RunnerOptions,
  context: AttemptContext,
  signal: AbortSignal,
  known?: {
    pr?: PullRequest
    checks?: Checks
    feedback?: PullRequestFeedback[]
  },
) {
  const { ticket, repository } = context
  const { database, github, workspaces } = options
  const branch = await workspaces.prepareRepository(repository, signal)
  const cwd = workspaces.path(ticket)
  const git = (args: string[]) => run('git', args, { cwd, signal })
  const localHead = await git(['rev-parse', 'HEAD'])
  const base = await git(['rev-parse', `origin/${branch}`])
  const pr =
    known?.pr ??
    (await github.inspect(repository.slug, ticket.pullRequestUrl!, signal))
  const head = pr.headRefOid ?? localHead
  const [checks, feedback, loaded, detail, behind, changed] = await Promise.all(
    [
      known?.checks ??
        github.checks(repository.slug, ticket.pullRequestUrl!, head, signal),
      known?.feedback ??
        github.feedback(repository.slug, ticket.pullRequestUrl!, signal),
      loadKit(cwd, base, signal),
      getTicketDetail(database, ticket.number),
      git(['rev-list', '--count', `${head}..${base}`]),
      git(['diff', '--no-renames', '--name-only', '-z', `${base}...${head}`]),
    ],
  )
  if (!detail) throw new Error('Missing ticket for merge gate')
  const latest = (role: string) =>
    detail.attempts.findLast(
      (a) =>
        a.waitingFor === null &&
        context.workflow.steps.some(
          (s) => s.id === a.stepId && s.kind === 'agent' && s.role === role,
        ),
    )
  const tester = latest('tester')
  const reproducer = latest('reproducer')
  const verdict = (attempt: typeof tester): VerdictFact | null =>
    attempt
      ? {
          status: attempt.status,
          outcome: attempt.outcome,
          commit: attempt.headCommit,
        }
      : null
  const reproduction = verdict(reproducer)
  // Original reproduction belongs to base; the independent tester re-confirms it on base/head.
  if (
    reproduction &&
    tester &&
    tester.reproductionAttemptId === reproducer?.id &&
    tester.status === 'finished' &&
    tester.outcome === 'passed'
  )
    reproduction.commit = tester.headCommit
  const facts = {
    observationError: pr.headRefOid ? null : 'GitHub PR head is unavailable',
    baseBranchMatches: pr.baseRefName === branch,
    head,
    localHead,
    base,
    behind: Number(behind),
    hasTester: context.workflow.steps.some(
      (s) => s.kind === 'agent' && s.role === 'tester',
    ),
    tester: verdict(tester),
    hasReproducer: context.workflow.steps.some(
      (s) => s.kind === 'agent' && s.role === 'reproducer',
    ),
    reproducer: reproduction,
    ci: checks.state,
    checks: checks.checks ?? [],
    feedback: [
      ...new Set(
        [
          ...freshFeedback(detail, feedback),
          ...feedback.filter((f) => f.changeRequest),
        ].map((f) => f.id),
      ),
    ],
    buildWork: detail.attempts.some((a) =>
      ['pending', 'running'].includes(a.status),
    ),
    state: pr.state,
    draft: pr.isDraft ?? null,
    mergeable: pr.mergeable ?? ('UNKNOWN' as const),
    paths: changed.split('\0').filter(Boolean),
    migrationGlobs: loaded.kit?.merge?.migrations ?? [],
    trustedKitError:
      loaded.state.status === 'invalid' ? loaded.state.error : null,
    approvedUnverified: null,
  }
  const gate = evaluateMergeGate(facts, new Date().toISOString())
  signal.throwIfAborted()
  await saveMergeGate(database, ticket.id, gate)
  return { gate, checks, feedback, pr }
}
