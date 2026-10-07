import { FactoryError } from '../domain/errors.ts'
import type { Lesson, LessonProposal, LessonStatus } from '../domain/lessons.ts'
import {
  transaction,
  type Connection,
  type Database,
  type Queryable,
} from './database.ts'
import { recordEvents, type NewEvent } from './events.ts'

interface LessonRow {
  id: number
  repository_id: number | null
  text: string
  source: Lesson['source']
  source_ticket_id: number
  key: string
  status: LessonStatus
  retired_reason: string | null
  created_at: Date
  decided_at: Date | null
}
function lesson(row: LessonRow): Lesson {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    text: row.text,
    source: row.source,
    sourceTicketId: row.source_ticket_id,
    key: row.key,
    status: row.status,
    retiredReason: row.retired_reason,
    createdAt: row.created_at.toISOString(),
    decidedAt: row.decided_at?.toISOString() ?? null,
  }
}
export async function listLessons(
  database: Queryable,
  filter: {
    repositoryId?: number | null
    status?: LessonStatus
  } = {},
): Promise<Lesson[]> {
  const { rows } = await database.query<LessonRow>(
    `SELECT * FROM lessons WHERE ($1::boolean OR repository_id IS NOT DISTINCT FROM $2::integer)
     AND ($3::text IS NULL OR status = $3) ORDER BY created_at, id`,
    [
      filter.repositoryId === undefined,
      filter.repositoryId ?? null,
      filter.status ?? null,
    ],
  )
  return rows.map(lesson)
}
export async function acceptedLessons(
  database: Queryable,
  repositoryId: number,
): Promise<Lesson[]> {
  const { rows } = await database.query<LessonRow>(
    `SELECT * FROM lessons WHERE status = 'accepted' AND (repository_id = $1 OR repository_id IS NULL)
     ORDER BY repository_id NULLS LAST, created_at, id`,
    [repositoryId],
  )
  return rows.map(lesson)
}
export async function insertLessonProposals(
  connection: Connection,
  proposals: readonly LessonProposal[],
  events: NewEvent[],
) {
  for (const proposal of proposals) {
    const { rows } = await connection.query<{ id: number }>(
      `INSERT INTO lessons (repository_id, text, source, source_ticket_id, key)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id`,
      [
        proposal.repositoryId,
        proposal.text,
        proposal.source,
        proposal.sourceTicketId,
        proposal.key,
      ],
    )
    if (rows[0])
      events.push({
        ticketId: null,
        kind: 'lesson.proposed',
        data: { lessonId: rows[0].id, repositoryId: proposal.repositoryId },
      })
  }
}

async function decideLesson(
  database: Database,
  id: number,
  status: 'accepted' | 'rejected' | 'retired',
  reason?: string,
): Promise<Lesson> {
  if (status === 'retired' && !reason?.trim())
    throw new FactoryError('invalid', 'Retiring a lesson requires a reason')
  return transaction(database, async (connection) => {
    const initial = await connection.query<LessonRow>(
      'SELECT * FROM lessons WHERE id = $1',
      [id],
    )
    if (!initial.rows[0])
      throw new FactoryError('not-found', `Lesson ${id} not found`)
    const repositoryId = initial.rows[0].repository_id
    // Serialise acceptance in a scope, including when concurrent requests target different lessons.
    await connection.query('SELECT pg_advisory_xact_lock($1, $2)', [
      4710280,
      repositoryId ?? 0,
    ])
    const { rows } = await connection.query<LessonRow>(
      'SELECT * FROM lessons WHERE id = $1 FOR UPDATE',
      [id],
    )
    const current = rows[0]!
    if (current.status === status) return lesson(current)
    const expected = status === 'retired' ? 'accepted' : 'proposed'
    if (current.status !== expected)
      throw new FactoryError(
        'conflict',
        `Only ${expected} lessons can be ${status}`,
      )
    if (status === 'accepted' && repositoryId !== null) {
      const count = await connection.query<{ count: string }>(
        "SELECT count(*) FROM lessons WHERE repository_id = $1 AND status = 'accepted'",
        [repositoryId],
      )
      if (Number(count.rows[0]!.count) >= 30)
        throw new FactoryError(
          'conflict',
          'At most 30 accepted lessons per repository; retire a lesson first',
        )
    }
    const updated = await connection.query<LessonRow>(
      'UPDATE lessons SET status = $2, retired_reason = $3, decided_at = now() WHERE id = $1 RETURNING *',
      [id, status, status === 'retired' ? reason!.trim() : null],
    )
    await recordEvents(connection, [
      {
        ticketId: null,
        kind: 'lesson.decided',
        data: { lessonId: id, repositoryId, status },
      },
    ])
    return lesson(updated.rows[0]!)
  })
}
export const acceptLesson = (database: Database, id: number) =>
  decideLesson(database, id, 'accepted')
export const rejectLesson = (database: Database, id: number) =>
  decideLesson(database, id, 'rejected')
export const retireLesson = (database: Database, id: number, reason: string) =>
  decideLesson(database, id, 'retired', reason)
