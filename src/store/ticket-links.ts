import type { Repository, TicketLink } from '../domain/records.ts'
import type { Queryable } from './database.ts'
import { getRepositoryById } from './repositories.ts'

export async function listDependencies(
  database: Queryable,
  ticketId: number,
): Promise<Repository[]> {
  const { rows } = await database.query<{ repository_id: number }>(
    'SELECT repository_id FROM ticket_dependencies WHERE ticket_id = $1 ORDER BY repository_id',
    [ticketId],
  )
  return Promise.all(
    rows.map(
      async (row) => (await getRepositoryById(database, row.repository_id))!,
    ),
  )
}

export async function listTicketLinks(
  database: Queryable,
  ticketId?: number,
): Promise<TicketLink[]> {
  const { rows } = await database.query<{
    id: number
    attempt_id: number
    original: TicketLink['original']
    linked: TicketLink['linked']
    merge_commit: string | null
    resolved_at: Date | null
  }>(
    `
    SELECT l.*, 
      jsonb_build_object('id', o.id, 'number', o.number, 'title', o.title, 'repository', jsonb_build_object('id', ro.id, 'slug', ro.slug), 'status', o.status, 'pullRequestUrl', o.pull_request_url) AS original,
      jsonb_build_object('id', t.id, 'number', t.number, 'title', t.title, 'repository', jsonb_build_object('id', rt.id, 'slug', rt.slug), 'status', t.status, 'pullRequestUrl', t.pull_request_url) AS linked
    FROM ticket_links l JOIN tickets o ON o.id = l.original_ticket_id JOIN repositories ro ON ro.id = o.repository_id
    JOIN tickets t ON t.id = l.linked_ticket_id JOIN repositories rt ON rt.id = t.repository_id
    WHERE ($1::integer IS NOT NULL AND $1 IN (o.id, t.id)) OR ($1 IS NULL AND l.resolved_at IS NULL AND o.status NOT IN ('done', 'cancelled') AND t.status IN ('done', 'cancelled'))
    ORDER BY l.id`,
    [ticketId ?? null],
  )
  return rows.map((row) => ({
    id: row.id,
    attemptId: row.attempt_id,
    original: row.original,
    linked: row.linked,
    mergeCommit: row.merge_commit,
    resolvedAt: row.resolved_at?.toISOString() ?? null,
  }))
}
