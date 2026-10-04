import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Database } from '../store/database.ts'
import { type EventSignal, latestEventId, listEvents } from '../store/events.ts'
import type { EventStreamReady } from './contract.ts'

const BATCH = 500
// Keeps proxies from closing an idle stream, and re-reads events in case a wake-up was missed.
const HEARTBEAT_MS = 15_000

/** Streams events after `after` (or after the latest event) until the client goes away. */
export function streamEvents(
  c: Context,
  database: Database,
  signal: EventSignal,
  after: number | undefined,
): Response {
  return streamSSE(c, async (stream) => {
    let dirty = true
    let wake = () => {}
    const unsubscribe = signal.subscribe(() => {
      dirty = true
      wake()
    })
    stream.onAbort(() => wake())
    try {
      let cursor = after ?? (await latestEventId(database))
      await stream.writeSSE({
        event: 'ready',
        data: JSON.stringify({
          lastEventId: cursor,
        } satisfies EventStreamReady),
        retry: 2000,
      })
      while (!stream.aborted) {
        if (!dirty) {
          const woken = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), HEARTBEAT_MS)
            wake = () => {
              clearTimeout(timer)
              resolve(true)
            }
          })
          if (stream.aborted) break
          if (!woken) await stream.write(': keep-alive\n\n')
        }
        dirty = false
        const events = await listEvents(database, {
          after: cursor,
          limit: BATCH,
        })
        for (const event of events) {
          await stream.writeSSE({
            id: String(event.id),
            data: JSON.stringify(event),
          })
          cursor = event.id
        }
        if (events.length === BATCH) dirty = true
      }
    } finally {
      unsubscribe()
    }
  })
}
