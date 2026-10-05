import { evaluateMergeGate } from '../domain/merge-gate.ts'
import type { MergeGate, GateSnapshot } from '../domain/merge-gate.ts'
import { recordEvents } from './events.ts'
import { transaction, type Database, type Queryable } from './database.ts'
export async function saveMergeGate(
  database: Database,
  ticketId: number,
  gate: MergeGate,
) {
  await transaction(database, async (connection) => {
    const previous = await getMergeGate(connection, ticketId)
    await connection.query(
      `INSERT INTO merge_gates(ticket_id, evaluation, last_green) VALUES ($1, $2, $3)
       ON CONFLICT(ticket_id) DO UPDATE SET evaluation = EXCLUDED.evaluation,
       last_green = COALESCE(EXCLUDED.last_green, merge_gates.last_green)`,
      [
        ticketId,
        JSON.stringify(gate),
        gate.ready ? JSON.stringify(gate) : null,
      ],
    )
    if (JSON.stringify(previous?.latest.facts) !== JSON.stringify(gate.facts))
      await recordEvents(connection, [
        {
          ticketId,
          kind: 'merge-gate.updated',
          data: { head: gate.facts.head, ready: gate.ready },
        },
      ])
  })
}
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

export async function invalidateMergeGate(
  database: Database,
  ticketId: number,
  error: unknown,
) {
  const snapshot = await getMergeGate(database, ticketId)
  if (snapshot)
    await saveMergeGate(
      database,
      ticketId,
      evaluateMergeGate(
        {
          ...snapshot.latest.facts,
          observationError: String(error).slice(0, 300),
        },
        new Date().toISOString(),
      ),
    )
}
