import { scenarioIndex } from '../domain/evidence.ts'
import { inspectArtifactFile } from '../api/artifact-files.ts'
import { realpath } from 'node:fs/promises'
import { retainArtifact } from '../artifacts/storage.ts'
import { unlink } from 'node:fs/promises'
import { getTicketDetail } from './tickets.ts'
import { recordEvents } from './events.ts'
import { transaction, type Database } from './database.ts'

/** Bounded background batches; the injected clock makes expiry deterministic. */
export async function pruneEvidence(
  database: Database,
  home: string,
  days = 30,
  now = new Date(),
  limit = 100,
): Promise<number> {
  const { rows } = await database.query<{ number: number }>(
    `SELECT t.number FROM tickets t WHERE t.status IN ('done', 'cancelled')
       AND t.evidence_pruned_at IS NULL
       AND t.updated_at <= $1::timestamptz - ($2 * interval '1 day')
       AND EXISTS (SELECT 1 FROM artifacts a WHERE a.ticket_id = t.id AND a.kind IN ('evidence', 'log') AND a.pruned_at IS NULL)
     ORDER BY t.id LIMIT 20`,
    [now.toISOString(), days],
  )
  if (!rows.length) return 0
  const root = await realpath(home)
  let pruned = 0
  for (const { number } of rows) {
    const detail = (await getTicketDetail(database, number))!
    const final =
      detail.attempts.findLast((a) => a.headCommit)?.headCommit ?? null
    const roles = new Map(
      detail.workflow.steps
        .filter((s) => s.kind === 'agent')
        .map((s) => [s.id, s.role]),
    )
    const keep = new Set(
      scenarioIndex(detail.artifacts, detail.attempts, roles, final)
        .filter((s) => s.current)
        .map((s) => s.artifactId),
    )
    const keptPaths = new Set(
      (
        await Promise.all(
          detail.artifacts
            .filter((a) => keep.has(a.id) && a.path)
            .map(async (a) => {
              const file = await inspectArtifactFile(home, a.path!)
              return file.ok ? file.path : null
            }),
        )
      ).filter((path) => path !== null),
    )
    for (const artifact of detail.artifacts) {
      if (pruned >= limit) return pruned
      if (
        !['evidence', 'log'].includes(artifact.kind) ||
        artifact.prunedAt ||
        keep.has(artifact.id)
      )
        continue
      await transaction(database, async (connection) => {
        // Lock against terminal-ticket changes before deleting bytes or changing their row.
        const eligible = await connection.query(
          `SELECT id FROM tickets WHERE id = $1 AND status IN ('done', 'cancelled') AND updated_at <= $2::timestamptz - ($3 * interval '1 day') FOR NO KEY UPDATE`,
          [detail.ticket.id, now.toISOString(), days],
        )
        if (!eligible.rowCount) return
        if (artifact.path) {
          const file = await inspectArtifactFile(home, artifact.path)
          if (!file.ok && file.reason !== 'missing') return
          if (file.ok) {
            // Only factory-owned per-ticket files may be deleted; legacy sources can be shared.
            if (!file.path.startsWith(`${root}/evidence/${detail.ticket.id}/`))
              return
            if (!keptPaths.has(file.path)) await unlink(file.path)
          }
        }
        await connection.query(
          'UPDATE artifacts SET content = NULL, pruned_at = $2, retention_days = $3 WHERE id = $1',
          [artifact.id, now.toISOString(), days],
        )
        await recordEvents(connection, [
          {
            ticketId: detail.ticket.id,
            kind: 'artifact.pruned',
            data: { artifactId: artifact.id, days },
          },
        ])
        pruned++
      })
    }
    await database.query(
      'UPDATE tickets SET evidence_pruned_at = $2 WHERE id = $1',
      [detail.ticket.id, now.toISOString()],
    )
  }
  return pruned
}

/** Adopt legacy completed files before pruning; active legacy logs keep their writer's path. */
export async function adoptEvidence(
  database: Database,
  home: string,
  limit = 100,
) {
  const { rows } = await database.query<{
    id: number
    ticket_id: number
    kind: 'evidence' | 'log' | 'note'
    title: string
    path: string
  }>(
    `SELECT a.id, a.ticket_id, a.kind, a.title, a.path FROM artifacts a JOIN attempts at ON at.id = a.attempt_id
     WHERE a.path IS NOT NULL AND a.pruned_at IS NULL AND at.status IN ('finished', 'failed', 'interrupted')
       AND a.path NOT LIKE $1 ORDER BY a.id LIMIT $2`,
    [`${home}/evidence/%`, limit],
  )
  for (const row of rows) {
    const file = await inspectArtifactFile(home, row.path)
    if (!file.ok) continue
    const retained = await retainArtifact(home, row.ticket_id, {
      kind: row.kind,
      title: row.title,
      path: row.path,
    })
    await database.query(
      'UPDATE tickets SET evidence_pruned_at = NULL WHERE id = $1',
      [row.ticket_id],
    )
    await database.query('UPDATE artifacts SET path = $2 WHERE id = $1', [
      row.id,
      retained.path,
    ])
  }
}
