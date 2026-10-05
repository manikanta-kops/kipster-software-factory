import type { DecisionInput } from '../domain/decisions.ts'
import { FactoryError } from '../domain/errors.ts'
import { listDecisions } from './decisions.ts'
import { transaction, type Database, type Queryable } from './database.ts'
import { recordEvents } from './events.ts'

export async function mergeDecision(
  database: Queryable,
  ticketId: number,
  head: string,
) {
  return (await listDecisions(database, ticketId)).find(
    (d) => d.purpose === 'merge' && d.facts.headCommit === head,
  )
}
export async function reserveMergeDecision(
  database: Database,
  ticketId: number,
  attemptId: number,
  input: DecisionInput,
): Promise<number | null> {
  return transaction(database, async (connection) => {
    const { rows } = await connection.query<{ id: number }>(
      `INSERT INTO decision_log(ticket_id, attempt_id, purpose, head_commit, input)
       SELECT t.id, a.id, 'merge', $3, $4 FROM tickets t JOIN attempts a ON a.ticket_id = t.id
       WHERE t.id = $1 AND a.id = $2 AND a.status = 'waiting' AND a.waiting_for = 'pull-request-merge'
       ON CONFLICT (ticket_id, head_commit) WHERE purpose = 'merge' DO NOTHING RETURNING id`,
      [ticketId, attemptId, input.facts.headCommit, JSON.stringify(input)],
    )
    return rows[0]?.id ?? null
  })
}
export async function saveMergeDecision(
  database: Database,
  id: number,
  input: DecisionInput,
) {
  await transaction(database, async (connection) => {
    const final = input.band === 'acted' ? input.answer!.choice : null
    const { rows } = await connection.query<{
      ticket_id: number
      attempt_id: number
    }>(
      `UPDATE decision_log SET input = $2, final_option = $3, decided_by = CASE WHEN $3::text IS NOT NULL THEN 'model' END,
       decided_at = CASE WHEN $3::text IS NOT NULL THEN now() END WHERE id = $1 AND purpose = 'merge' RETURNING ticket_id, attempt_id`,
      [id, JSON.stringify(input), final],
    )
    if (!rows[0]) throw new Error('Missing merge decision')
    await recordEvents(connection, [
      {
        ticketId: rows[0].ticket_id,
        kind: 'decision.made',
        data: {
          attemptId: rows[0].attempt_id,
          decisionId: id,
          purpose: 'merge',
          choice: final,
          band: input.band,
        },
      },
    ])
  })
}
export async function confirmMergeDecision(
  database: Database,
  ticketNumber: number,
  id: number,
  option: 'merge' | 'owner',
) {
  await transaction(database, async (connection) => {
    const { rows } = await connection.query<{
      ticket_id: number
      input: DecisionInput
    }>(
      `SELECT d.ticket_id, d.input FROM decision_log d JOIN tickets t ON t.id = d.ticket_id
       JOIN attempts a ON a.ticket_id = t.id JOIN repositories r ON r.id = t.repository_id
       JOIN merge_gates g ON g.ticket_id = t.id
       WHERE t.number = $1 AND d.id = $2 AND d.purpose = 'merge' AND d.final_option IS NULL
       AND a.status = 'waiting' AND a.waiting_for = 'pull-request-merge'
       AND d.input->>'band' = 'confirm' AND d.input->'answer'->>'choice' = 'merge'
       AND d.head_commit = g.evaluation->'facts'->>'head' AND r.auto_merge
       AND g.evaluation->>'ready' = 'true' AND g.evaluation->'needsOwner' = '[]'::jsonb
       FOR NO KEY UPDATE OF t, d`,
      [ticketNumber, id],
    )
    if (!rows[0])
      throw new FactoryError(
        'conflict',
        'This merge decision is no longer available; refresh the ticket',
      )
    await connection.query(
      `UPDATE decision_log SET final_option = $2, decided_by = 'owner', overridden = $3, decided_at = now() WHERE id = $1`,
      [id, option, rows[0].input.answer?.choice !== option],
    )
    await recordEvents(connection, [
      {
        ticketId: rows[0].ticket_id,
        kind: 'decision.made',
        data: {
          decisionId: id,
          purpose: 'merge',
          choice: option,
          decidedBy: 'owner',
        },
      },
    ])
  })
}
export async function markMergeRequested(
  database: Database,
  id: number,
): Promise<boolean> {
  const { rowCount } = await database.query(
    `UPDATE decision_log d SET merge_requested_at = now()
     FROM tickets t, attempts a, repositories r
     WHERE d.id = $1 AND d.ticket_id = t.id AND t.repository_id = r.id AND r.auto_merge
     AND a.ticket_id = t.id AND a.status = 'waiting' AND a.waiting_for = 'pull-request-merge'
     AND d.merge_requested_at IS NULL AND d.final_option = 'merge'`,
    [id],
  )
  return rowCount === 1
}
export async function markMergeResult(
  database: Queryable,
  id: number,
  error?: string,
) {
  await database.query(
    `UPDATE decision_log SET merge_succeeded_at = CASE WHEN $2::text IS NULL THEN now() END, merge_error = $2 WHERE id = $1`,
    [id, error ?? null],
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
