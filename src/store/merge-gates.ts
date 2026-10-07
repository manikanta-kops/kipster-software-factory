import { getMergeGate } from './gate-records.ts'
export { getMergeGate } from './gate-records.ts'
import { lockTicket, refreshTicketSummary } from './tickets.ts'
import { evaluateMergeGate } from '../domain/merge-gate.ts'
import type { MergeGate } from '../domain/merge-gate.ts'
import { recordEvents } from './events.ts'
import { transaction, type Database } from './database.ts'
export async function saveMergeGate(
  database: Database,
  ticketId: number,
  gate: MergeGate,
) {
  await transaction(database, async (connection) => {
    const ticket = await lockTicket(connection, { id: ticketId })
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
    if (JSON.stringify(previous?.latest.facts) !== JSON.stringify(gate.facts)) {
      const events = [
        {
          ticketId,
          kind: 'merge-gate.updated' as const,
          data: { head: gate.facts.head, ready: gate.ready },
        },
      ]
      await refreshTicketSummary(connection, ticket.number, events)
      await recordEvents(connection, events)
    }
  })
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
