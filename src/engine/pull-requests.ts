import { refreshMergeGate, freshFeedback } from './merge-gate.ts'
import { settledCI } from '../domain/auto-merge.ts'
import { baseSyncCount, beginBaseSync } from '../store/auto-merge.ts'
import { actions } from '../domain/catalog.ts'
import type { ArtifactInput } from '../domain/lifecycle.ts'
import { run } from '../executors/process.ts'
import { FACTORY_MARKER } from '../github/feedback.ts'
import { isLatestTesterVerdictCurrent } from '../store/verdicts.ts'
import {
  completeAttempt,
  getTicketDetail,
  requeuePullRequestMaintenance,
  setPullRequestUrl,
  waitForPullRequestMerge,
  type AttemptContext,
  type TicketDetail,
} from '../store/tickets.ts'
import type { RunnerOptions } from './runner.ts'
import { writePullRequest } from './pr-writer.ts'

function hasStaleReview(
  detail: TicketDetail,
  context: AttemptContext,
  head: string,
) {
  const reviewer = detail.attempts.findLast(
    (a) =>
      a.waitingFor === null &&
      context.workflow.steps.some(
        (s) => s.id === a.stepId && s.kind === 'agent' && s.role === 'reviewer',
      ),
  )
  return (
    !!reviewer &&
    (reviewer.status !== 'finished' ||
      reviewer.outcome !== 'passed' ||
      reviewer.headCommit !== head)
  )
}

export async function maintainPullRequest(
  options: RunnerOptions,
  context: AttemptContext,
  cwd: string,
  signal: AbortSignal,
) {
  const { database, github } = options
  const { ticket, repository, attempt } = context
  const git = (args: string[]) => run('git', args, { cwd, signal })
  if (await git(['status', '--porcelain']))
    throw new Error('Cannot sync a dirty ticket worktree')
  // The workspace preparation fetched origin. Pin the base so another ticket's fetch cannot change this merge.
  const base = await git(['rev-parse', `origin/${repository.defaultBranch}`])
  const params = actions['maintain-pr'].params.parse(
    context.step.kind === 'system' ? context.step.with : {},
  )
  const missingBase =
    Number(await git(['rev-list', '--count', `HEAD..${base}`])) > 0
  const detail = (await getTicketDetail(database, ticket.number))!
  const previous = detail.attempts.findLast((a) => a.id < attempt.id)
  const resync =
    previous?.status === 'finished' &&
    ['pull-request-checks', 'pull-request-merge'].includes(
      previous.waitingFor ?? '',
    ) &&
    previous.next?.to === 'step' &&
    previous.next.stepId === attempt.stepId
  if (
    missingBase &&
    resync &&
    !(await beginBaseSync(database, ticket.id, params.maxBaseSyncs))
  ) {
    await completeAttempt(database, attempt.id, {
      outcome: 'needs-decision',
      summary: `Stopped after ${params.maxBaseSyncs} consecutive base re-syncs. Review the branch and retry to reset the bound.`,
      artifacts: [],
    })
    return
  }
  try {
    await git([
      '-c',
      'user.name=Kipster Factory',
      '-c',
      'user.email=kipster@localhost',
      'merge',
      '--no-edit',
      base,
    ])
  } catch (error) {
    // Abort even after cancellation; a conflicted index must never survive this system action.
    const files = await run('git', ['diff', '--name-only', '--diff-filter=U'], {
      cwd,
      signal: AbortSignal.timeout(5000),
    })
    const merging = await run('git', ['rev-parse', '--verify', 'MERGE_HEAD'], {
      cwd,
      signal: AbortSignal.timeout(5000),
    }).catch(() => null)
    if (merging)
      await run('git', ['merge', '--abort'], {
        cwd,
        signal: AbortSignal.timeout(5000),
      })
    signal.throwIfAborted()
    if (!files) throw error
    await completeAttempt(
      database,
      attempt.id,
      {
        outcome: 'conflict',
        summary:
          'Resolve the base merge conflicts, commit the resolution and run verification again.',
        artifacts: [
          {
            kind: 'finding',
            title: 'Base merge conflicts',
            content: `Merge origin/${repository.defaultBranch} into the ticket branch and resolve these files:\n\n${files
              .split('\n')
              .map((f) => `- ${f}`)
              .join(
                '\n',
              )}\n\nThe system aborted its merge; your branch is unchanged.`,
          },
        ],
      },
      { headCommit: await git(['rev-parse', 'HEAD']) },
    )
    return
  }
  const head = await git(['rev-parse', 'HEAD'])
  const testerSteps = new Set(
    context.workflow.steps
      .filter((s) => s.kind === 'agent' && s.role === 'tester')
      .map((s) => s.id),
  )
  const hasVerdict = detail.attempts.some(
    (a) => testerSteps.has(a.stepId) && a.waitingFor === null,
  )
  const verdictCurrent = await isLatestTesterVerdictCurrent(
    database,
    ticket.id,
    head,
  )
  // Also catches a restart after the merge was committed but before the result was saved.
  if (
    (hasVerdict && !verdictCurrent) ||
    hasStaleReview(detail, context, head)
  ) {
    const role = hasVerdict && !verdictCurrent ? 'tester' : 'reviewer'
    await completeAttempt(
      database,
      attempt.id,
      {
        outcome: 'base-moved',
        summary: `The latest ${role} verdict is not current for ${head}; ${role === 'tester' ? 're-test' : 'review again'} before publishing.`,
        artifacts: [
          {
            kind: 'finding',
            title: 'Verification needs a new verdict',
            content: `The branch includes origin/${repository.defaultBranch} at ${base}. Refresh the ${role} verdict at ${head}; the previous verdict does not cover this commit.`,
          },
        ],
      },
      { headCommit: head },
    )
    return
  }
  if (Number(await git(['rev-list', '--count', `${base}..HEAD`])) === 0) {
    await completeAttempt(
      database,
      attempt.id,
      {
        outcome: 'needs-decision',
        summary: 'The ticket branch has no commits to publish.',
        artifacts: [],
      },
      { headCommit: head },
    )
    return
  }
  const body = await writePullRequest(options, context, cwd, head, signal)
  await git(['push', '--set-upstream', 'origin', ticket.branch])
  const pr = await github.maintain({
    repository: repository.slug,
    branch: ticket.branch,
    base: repository.defaultBranch,
    title: ticket.title,
    body: `${body}\n\n${FACTORY_MARKER}`,
    cwd,
    signal,
  })
  signal.throwIfAborted()
  await setPullRequestUrl(database, ticket.id, pr.url)
  const waiting = await waitForPullRequestMerge(
    database,
    attempt.id,
    'pull-request-checks',
    head,
  )
  // One snapshot handles absent/finished CI immediately; pending checks release the slot.
  await pollPullRequestChecks(
    options,
    {
      ...context,
      attempt: waiting,
      ticket: { ...ticket, pullRequestUrl: pr.url },
    },
    signal,
  )
}

export async function pollPullRequestChecks(
  options: RunnerOptions,
  context: AttemptContext,
  signal: AbortSignal,
) {
  const { database, github, workspaces } = options
  const { ticket, repository, attempt, step } = context
  if (!ticket.pullRequestUrl || !attempt.headCommit || step.kind !== 'system')
    throw new Error('Missing CI wait state')
  const head = attempt.headCommit
  const finish = (
    outcome: string,
    summary: string,
    artifacts: ArtifactInput[] = [],
  ) =>
    completeAttempt(
      database,
      attempt.id,
      { outcome, summary, artifacts },
      { headCommit: head },
    )
  const { ciTimeoutMinutes, ciSettleMinutes } = actions[
    'maintain-pr'
  ].params.parse(step.with)
  if (
    Date.now() - Date.parse(attempt.waitingSince!) >=
    ciTimeoutMinutes * 60_000
  ) {
    await finish(
      'needs-decision',
      `CI did not finish within ${ciTimeoutMinutes} minutes for ${head}. Inspect the checks and retry when ready.`,
    )
    return
  }
  const localHead = await run('git', ['rev-parse', 'HEAD'], {
    cwd: workspaces.path(ticket),
    signal,
  })
  if (localHead !== head) {
    await refreshMergeGate(options, context, signal)
    await finish(
      'needs-decision',
      'The ticket branch changed while CI was waiting; retry maintain-pr to publish and verify it.',
    )
    return
  }
  const checks = settledCI(
    await github.checks(repository.slug, ticket.pullRequestUrl, head, signal),
    attempt.waitingSince!,
    ciSettleMinutes,
    Date.now(),
  )
  await refreshMergeGate(options, context, signal, { checks })
  signal.throwIfAborted()
  if (checks.state === 'head-changed') {
    await finish(
      'needs-decision',
      'The pull request head changed on GitHub; reconcile the branch before retrying maintain-pr.',
    )
  } else if (checks.state === 'failed') {
    await finish(
      'ci-failed',
      `CI failed: ${checks.failures.map((f) => f.name).join(', ')}`,
      checks.failures.map((f) => ({
        kind: 'finding',
        title: `CI failed: ${f.name}`.slice(0, 200),
        content: `[${f.name}](${f.url})\n\n${f.excerpt.slice(-2000)}`,
      })),
    )
  } else if (await pollPullRequestBase(options, context, signal)) {
    return
  } else if (checks.state !== 'pending') {
    await finish(
      'ready',
      `Pull request: ${ticket.pullRequestUrl}. ${checks.state === 'none' ? 'No checks configured.' : 'CI passed.'}`,
    )
  }
}

export async function pollPullRequestBase(
  options: RunnerOptions,
  context: AttemptContext,
  signal: AbortSignal,
): Promise<boolean> {
  const { database, workspaces } = options
  const { ticket, repository, attempt, workflow } = context
  const detail = (await getTicketDetail(database, ticket.number))!
  if (
    !detail.attempts.some((previous) =>
      workflow.steps.some(
        (step) =>
          step.id === previous.stepId &&
          step.kind === 'system' &&
          step.action === 'maintain-pr',
      ),
    )
  )
    return false
  const branch = await workspaces.prepareRepository(repository, signal)
  const cwd = workspaces.path(ticket)
  const base = await run('git', ['rev-parse', `origin/${branch}`], {
    cwd,
    signal,
  })
  const missing = await run('git', ['rev-list', '--count', `HEAD..${base}`], {
    cwd,
    signal,
  })
  const missingBase = Number(missing) > 0
  const head = await run('git', ['rev-parse', 'HEAD'], { cwd, signal })
  if (!missingBase && !hasStaleReview(detail, context, head)) return false
  signal.throwIfAborted()
  const maintenance = [...detail.attempts]
    .reverse()
    .map((a) => workflow.steps.find((s) => s.id === a.stepId))
    .find((s) => s?.kind === 'system' && s.action === 'maintain-pr')!
  const { maxBaseSyncs } = actions['maintain-pr'].params.parse(
    maintenance.kind === 'system' ? maintenance.with : {},
  )
  if (
    missingBase &&
    (await baseSyncCount(database, ticket.id)) >= maxBaseSyncs
  ) {
    await completeAttempt(database, attempt.id, {
      outcome: 'needs-decision',
      summary: `Stopped after ${maxBaseSyncs} consecutive base re-syncs. Base origin/${branch} moved again; review and retry to reset the bound.`,
      artifacts: [],
    })
    return true
  }
  // Polling never merges or starts a writer outside the scheduler's execution limit.
  await requeuePullRequestMaintenance(
    database,
    attempt.id,
    missingBase
      ? `Base origin/${branch} advanced to ${base}; queued maintain-pr to synchronize and refresh verification before merge.`
      : `The latest reviewer verdict does not cover ${head}; queued maintain-pr to refresh review before merge.`,
  )
  return true
}

export async function pollPullRequestFeedback(
  options: RunnerOptions,
  context: AttemptContext,
  signal: AbortSignal,
): Promise<boolean> {
  const { database, github } = options
  const { ticket, repository, attempt } = context
  const feedback = await github.feedback(
    repository.slug,
    ticket.pullRequestUrl!,
    signal,
  )
  const detail = (await getTicketDetail(database, ticket.number))!
  const fresh = freshFeedback(detail, feedback)
  if (!fresh.length) return false
  signal.throwIfAborted()
  await completeAttempt(database, attempt.id, {
    outcome: 'changes-needed',
    summary: 'New pull request feedback needs the builder.',
    artifacts: fresh.map((f) => ({
      kind: 'comment',
      title: `GitHub feedback from ${f.author}`.slice(0, 200),
      content: `[Feedback from ${f.author}](${f.url})\n\n${f.body}\n\n<!-- github-feedback:${f.id} -->`,
    })),
  })
  return true
}
