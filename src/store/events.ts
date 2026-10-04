import type { PoolClient } from 'pg'
import type { EventKind, FactoryEvent } from '../domain/records.ts'
import type { Connection, Database, Queryable } from './database.ts'

export interface NewEvent {
  readonly ticketId: number | null
  readonly kind: EventKind
  readonly data: Readonly<Record<string, unknown>>
}

export const EVENT_CHANNEL = 'factory_events'

// Held until commit, so event ids become visible in increasing order and a reader
// resuming after id N never misses an event that commits later with a smaller id.
const EVENT_LOCK = 4_710_272

/** Appends events; call it last in a transaction, as it serialises commits that record events. */
export async function recordEvents(
  connection: Connection,
  events: readonly NewEvent[],
): Promise<void> {
  if (events.length === 0) return
  await connection.query('SELECT pg_advisory_xact_lock($1)', [EVENT_LOCK])
  await connection.query(
    `INSERT INTO events (ticket_id, kind, data)
     SELECT ticket_id, kind, data
     FROM unnest($1::integer[], $2::text[], $3::jsonb[]) WITH ORDINALITY
       AS e (ticket_id, kind, data, position)
     ORDER BY position`,
    [
      events.map((event) => event.ticketId),
      events.map((event) => event.kind),
      events.map((event) => JSON.stringify(event.data)),
    ],
  )
}

interface EventRow {
  id: string
  ticket_id: number | null
  number: number | null
  kind: EventKind
  data: Record<string, unknown>
  created_at: Date
}

/** Events after `after`, oldest first; only one ticket's when `ticketId` is given. */
export async function listEvents(
  database: Queryable,
  options: {
    readonly after?: number
    readonly ticketId?: number
    readonly limit?: number
  } = {},
): Promise<FactoryEvent[]> {
  const { rows } = await database.query<EventRow>(
    `SELECT e.id, e.ticket_id, t.number, e.kind, e.data, e.created_at
     FROM events e LEFT JOIN tickets t ON t.id = e.ticket_id
     WHERE e.id > $1 AND ($2::integer IS NULL OR e.ticket_id = $2)
     ORDER BY e.id
     LIMIT $3`,
    [options.after ?? 0, options.ticketId ?? null, options.limit ?? 1000],
  )
  return rows.map((row) => ({
    id: Number(row.id),
    ticketId: row.ticket_id,
    ticketNumber: row.number,
    kind: row.kind,
    data: row.data,
    createdAt: row.created_at.toISOString(),
  }))
}

export async function latestEventId(database: Queryable): Promise<number> {
  const { rows } = await database.query<{ id: string | null }>(
    'SELECT max(id) AS id FROM events',
  )
  return Number(rows[0]?.id ?? 0)
}

/** Wakes subscribers whenever an event is recorded. */
export interface EventSignal {
  /** Resolves once the first LISTEN is active. */
  readonly ready: Promise<void>
  subscribe(listener: () => void): () => void
  close(): Promise<void>
}

/**
 * Listens for new events on one dedicated connection. A lost connection is
 * re-established, and subscribers are woken afterwards to catch up.
 */
export function listenForEvents(database: Database): EventSignal {
  const listeners = new Set<() => void>()
  let client: PoolClient | undefined
  let retry: NodeJS.Timeout | undefined
  let closed = false

  const wake = () => {
    for (const listener of listeners) listener()
  }

  const connect = async (): Promise<void> => {
    let connection: PoolClient | undefined
    try {
      connection = await database.connect()
      const current = connection
      current.on('notification', wake)
      current.on('error', () => {
        if (client !== current) return
        client = undefined
        current.release(true)
        reconnect()
      })
      await current.query(`LISTEN ${EVENT_CHANNEL}`)
      if (closed) {
        current.release(true)
        return
      }
      client = current
      wake()
    } catch {
      connection?.release(true)
      reconnect()
    }
  }

  const reconnect = () => {
    if (!closed) retry = setTimeout(() => void connect(), 1000)
  }

  return {
    ready: connect(),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async close() {
      closed = true
      clearTimeout(retry)
      listeners.clear()
      client?.release(true)
      client = undefined
    },
  }
}
