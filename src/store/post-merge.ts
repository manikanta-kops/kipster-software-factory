import type { Checks } from '../github/checks.ts'
import type { PullRequest } from '../github/github.ts'
import type { LibraryEntry } from '../library/library.ts'
import { FactoryError } from '../domain/errors.ts'
import { transaction, type Database, type Queryable } from './database.ts'
import { mergeDecision } from './auto-merge.ts'
import { recordEvents } from './events.ts'
import { createTicketInTransaction, type AttemptContext } from './tickets.ts'

export interface PostMergeCheck {
  repositoryId: number
  mergeCommit: string
  ticketId: number
  attemptId: number
  pullRequestUrl: string
  hadCI: boolean
  mergedBy: 'factory' | 'owner'
  createdAt: string
}
export async function recordMergedPR(
  database: Database,
  context: AttemptContext,
  pr: PullRequest,
  hadCI: boolean,
) {
  const commit = pr.mergeCommit?.oid
  if (!commit || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit))
    throw new Error('Merged PR has no merge commit; retry observation')
  const decision = pr.headRefOid
    ? await mergeDecision(database, context.ticket.id, pr.headRefOid)
    : undefined
  const by = decision?.mergeSucceededAt ? 'factory' : 'owner'
  await transaction(database, async (connection) => {
    const { rowCount } = await connection.query(
      `INSERT INTO post_merge_checks(repository_id, merge_commit, ticket_id, attempt_id, pull_request_url, had_ci, merged_by, decision_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
      [
        context.repository.id,
        commit,
        context.ticket.id,
        context.attempt.id,
        pr.url,
        hadCI,
        by,
        decision?.id ?? null,
      ],
    )
    if (rowCount)
      await recordEvents(connection, [
        {
          ticketId: context.ticket.id,
          kind: 'pull-request.merged',
          data: {
            summary: `Merged by ${by}: ${pr.url}`,
            mergedBy: by,
            mergeCommit: commit,
            decisionId: decision?.id ?? null,
          },
        },
      ])
  })
  return by
}
export async function pendingPostMergeChecks(
  database: Queryable,
): Promise<PostMergeCheck[]> {
  const { rows } = await database.query<{
    repository_id: number
    merge_commit: string
    ticket_id: number
    attempt_id: number
    pull_request_url: string
    had_ci: boolean
    merged_by: 'factory' | 'owner'
    created_at: Date
  }>(
    "SELECT * FROM post_merge_checks WHERE status = 'pending' ORDER BY last_polled_at NULLS FIRST, created_at LIMIT 100",
  )
  return rows.map((r) => ({
    repositoryId: r.repository_id,
    mergeCommit: r.merge_commit,
    ticketId: r.ticket_id,
    attemptId: r.attempt_id,
    pullRequestUrl: r.pull_request_url,
    hadCI: r.had_ci,
    mergedBy: r.merged_by,
    createdAt: r.created_at.toISOString(),
  }))
}
export async function finishPostMergeCheck(
  database: Database,
  check: PostMergeCheck,
  status: 'passed' | 'failed' | 'unavailable',
  checks: Checks,
  bugWorkflow?: LibraryEntry,
) {
  return transaction(database, async (connection) => {
    // Lock the original ticket before adding either ticket's events.
    await connection.query(
      'SELECT id FROM tickets WHERE id = $1 FOR NO KEY UPDATE',
      [check.ticketId],
    )
    const { rows } = await connection.query<{
      status: string
      bug_ticket_id: number | null
    }>(
      'SELECT status, bug_ticket_id FROM post_merge_checks WHERE repository_id = $1 AND merge_commit = $2 FOR UPDATE',
      [check.repositoryId, check.mergeCommit],
    )
    if (!rows[0]) throw new FactoryError('not-found', 'No post-merge check')
    if (rows[0].status !== 'pending') return rows[0].bug_ticket_id
    let bug = null
    if (status === 'failed') {
      if (!bugWorkflow) throw new Error('Missing bug workflow')
      const { rows: repositories } = await connection.query<{ slug: string }>(
        'SELECT slug FROM repositories WHERE id = $1',
        [check.repositoryId],
      )
      const prNumber = new URL(check.pullRequestUrl).pathname.split('/').at(-1)
      bug = await createTicketInTransaction(
        connection,
        {
          repository: repositories[0]!.slug,
          workflow: bugWorkflow,
          title:
            `Breakage after #${prNumber}: ${checks.failures.map((f) => f.name).join(', ')}`.slice(
              0,
              200,
            ),
          body: `Post-merge checks failed for [PR #${prNumber}](${check.pullRequestUrl}) at merge commit ${check.mergeCommit}.\n\n${checks.failures.map((f) => `### ${f.name}\n\n${f.url ? `[Check](${f.url})\n\n` : ''}${f.excerpt.slice(-2000)}`).join('\n\n')}`,
        },
        false,
      )
    }
    const summary = bug
      ? `Post-merge breakage: [bug ticket #${bug.number}](#/tickets/${bug.number}) opened for ${check.mergeCommit}.`
      : `Post-merge check ${status} at ${check.mergeCommit}.`
    await connection.query(
      `UPDATE post_merge_checks SET status = $3, checks = $4, bug_ticket_id = $5, checked_at = now() WHERE repository_id = $1 AND merge_commit = $2`,
      [
        check.repositoryId,
        check.mergeCommit,
        status,
        JSON.stringify(checks),
        bug?.id ?? null,
      ],
    )
    await connection.query(
      `INSERT INTO artifacts(ticket_id, attempt_id, kind, title, content, media_type) VALUES ($1, $2, 'note', $3, $4, 'text/markdown')`,
      [
        check.ticketId,
        check.attemptId,
        bug ? 'Post-merge breakage' : `Post-merge check ${status}`,
        summary,
      ],
    )
    await recordEvents(connection, [
      {
        ticketId: check.ticketId,
        kind: 'post-merge.checked',
        data: {
          summary,
          status,
          mergeCommit: check.mergeCommit,
          bugTicketNumber: bug?.number ?? null,
        },
      },
    ])
    return bug?.id ?? null
  })
}

export async function markPostMergePolled(
  database: Queryable,
  check: PostMergeCheck,
) {
  await database.query(
    "UPDATE post_merge_checks SET last_polled_at = now() WHERE repository_id = $1 AND merge_commit = $2 AND status = 'pending'",
    [check.repositoryId, check.mergeCommit],
  )
}
