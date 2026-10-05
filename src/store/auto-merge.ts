import type { MergeGate } from '../domain/merge-gate.ts'
import { transaction, type Database, type Queryable } from './database.ts'
import { recordEvents } from './events.ts'
import type { AttemptContext } from './tickets.ts'

export async function markMergeRequested(
  database: Database,
  context: AttemptContext,
  gate: MergeGate,
): Promise<boolean> {
  return transaction(database, async (connection) => {
    const { rowCount } = await connection.query(
      `INSERT INTO merge_requests(ticket_id, head_commit, gate)
       SELECT t.id, $3, $4 FROM tickets t JOIN attempts a ON a.ticket_id = t.id
       JOIN repositories r ON r.id = t.repository_id
       WHERE t.id = $1 AND a.id = $2 AND r.auto_merge
       AND a.status = 'waiting' AND a.waiting_for = 'pull-request-merge'
       ON CONFLICT(ticket_id, head_commit) DO UPDATE SET gate = EXCLUDED.gate, error = NULL
       WHERE merge_requests.succeeded_at IS NULL`,
      [
        context.ticket.id,
        context.attempt.id,
        gate.facts.head,
        JSON.stringify(gate),
      ],
    )
    if (rowCount)
      await recordEvents(connection, [
        {
          ticketId: context.ticket.id,
          kind: 'pull-request.merge-requested',
          data: {
            head: gate.facts.head,
            summary: `Factory merge authorized by the gate and passing independent tester and reviewer at ${gate.facts.head}.`,
          },
        },
      ])
    return rowCount === 1
  })
}
export async function markMergeResult(
  database: Queryable,
  ticketId: number,
  head: string,
  error?: string,
) {
  await database.query(
    `UPDATE merge_requests SET succeeded_at = CASE WHEN $3::text IS NULL THEN now() ELSE succeeded_at END, error = $3
     WHERE ticket_id = $1 AND head_commit = $2`,
    [ticketId, head, error ?? null],
  )
}
export async function baseSyncCount(
  database: Queryable,
  ticketId: number,
): Promise<number> {
  const { rows } = await database.query<{ count: number }>(
    'SELECT count FROM base_syncs WHERE ticket_id = $1',
    [ticketId],
  )
  return rows[0]?.count ?? 0
}
export async function beginBaseSync(
  database: Queryable,
  ticketId: number,
  maximum: number,
): Promise<boolean> {
  if (maximum === 0) return false
  const { rowCount } = await database.query(
    `INSERT INTO base_syncs(ticket_id, count) VALUES ($1, 1)
    ON CONFLICT(ticket_id) DO UPDATE SET count = base_syncs.count + 1 WHERE base_syncs.count < $2 RETURNING count`,
    [ticketId, maximum],
  )
  return rowCount === 1
}
