import type { Database } from './database.ts'
export async function getPullRequestDescription(
  database: Database,
  ticketId: number,
  head: string,
): Promise<string | null> {
  const { rows } = await database.query<{ body: string }>(
    'SELECT body FROM pull_request_descriptions WHERE ticket_id = $1 AND head_commit = $2',
    [ticketId, head],
  )
  return rows[0]?.body ?? null
}
export async function savePullRequestDescription(
  database: Database,
  ticketId: number,
  head: string,
  body: string,
) {
  await database.query(
    'INSERT INTO pull_request_descriptions (ticket_id, head_commit, body) VALUES ($1, $2, $3) ON CONFLICT (ticket_id, head_commit) DO UPDATE SET body = EXCLUDED.body',
    [ticketId, head, body],
  )
}
