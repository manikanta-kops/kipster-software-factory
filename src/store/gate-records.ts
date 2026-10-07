import type { GateSnapshot, MergeGate } from '../domain/merge-gate.ts'
import type { Queryable } from './database.ts'

export async function getMergeGate(
  database: Queryable,
  ticketId: number,
): Promise<GateSnapshot | null> {
  const { rows } = await database.query<{
    evaluation: MergeGate
    last_green: MergeGate | null
  }>('SELECT evaluation, last_green FROM merge_gates WHERE ticket_id = $1', [
    ticketId,
  ])
  return rows[0]
    ? { latest: rows[0].evaluation, lastGreen: rows[0].last_green }
    : null
}
