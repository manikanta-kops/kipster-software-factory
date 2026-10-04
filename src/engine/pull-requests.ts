import { actions } from '../domain/catalog.ts'
import type { ArtifactInput } from '../domain/lifecycle.ts'
import { run } from '../executors/process.ts'
import { FACTORY_MARKER } from '../github/feedback.ts'
import { isLatestTesterVerdictCurrent } from '../store/verdicts.ts'
import {
  completeAttempt,
  getTicketDetail,
  setPullRequestUrl,
  waitForPullRequestMerge,
  type AttemptContext,
} from '../store/tickets.ts'
import type { RunnerOptions } from './runner.ts'
import { writePullRequest } from './pr-writer.ts'

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
  const detail = (await getTicketDetail(database, ticket.number))!
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
  if (hasVerdict && !verdictCurrent) {
    await completeAttempt(
      database,
      attempt.id,
      {
        outcome: 'base-moved',
        summary: `The latest tester verdict is not current for ${head}; re-test before publishing.`,
        artifacts: [
          {
            kind: 'finding',
            title: 'Verification needs a new verdict',
            content: `The branch includes origin/${repository.defaultBranch} at ${base}. Re-test ${head}; the previous verdict does not cover this commit.`,
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
  const { ciTimeoutMinutes } = actions['maintain-pr'].params.parse(step.with)
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
    await finish(
      'needs-decision',
      'The ticket branch changed while CI was waiting; retry maintain-pr to publish and verify it.',
    )
    return
  }
  const checks = await github.checks(
    repository.slug,
    ticket.pullRequestUrl,
    head,
    signal,
  )
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
  } else if (checks.state !== 'pending') {
    await finish(
      'ready',
      `Pull request: ${ticket.pullRequestUrl}. ${checks.state === 'none' ? 'No checks configured.' : 'CI passed.'}`,
    )
  }
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
  const fresh = feedback.filter(
    (f) =>
      Date.parse(f.createdAt) >= Date.parse(ticket.createdAt) &&
      !detail.artifacts.some(
        (a) =>
          a.kind === 'comment' &&
          a.content?.includes(`<!-- github-feedback:${f.id} -->`),
      ),
  )
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
