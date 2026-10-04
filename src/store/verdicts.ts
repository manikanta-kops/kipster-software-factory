import type { Queryable } from './database.ts'

/** Latest tester execution must be a passing verdict at this exact commit. */
export async function isLatestTesterVerdictCurrent(
  database: Queryable,
  ticketId: number,
  headCommit: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(headCommit)) return false
  const { rows } = await database.query<{
    status: string
    outcome: string | null
    head_commit: string | null
  }>(
    `SELECT a.status, a.outcome, a.head_commit
     FROM attempts a
     JOIN tickets t ON t.id = a.ticket_id
     JOIN workflow_versions w ON w.name = t.workflow_name AND w.version = t.workflow_version
     WHERE a.ticket_id = $1 AND a.waiting_for IS NULL
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(w.definition->'steps') s
         WHERE s->>'id' = a.step_id AND s->>'kind' = 'agent' AND s->>'role' = 'tester'
       )
     ORDER BY a.id DESC LIMIT 1`,
    [ticketId],
  )
  const latest = rows[0]
  return (
    latest?.status === 'finished' &&
    latest.outcome === 'passed' &&
    latest.head_commit === headCommit
  )
}
