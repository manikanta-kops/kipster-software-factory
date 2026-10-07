import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import type { TestContext } from 'node:test'
import type { Database } from '../../src/store/database.ts'

/** The deadline bounds a hang; success always comes from the observed condition. */
export async function until<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeout = 60_000,
): Promise<T> {
  const end = performance.now() + timeout
  while (true) {
    const value = await read()
    if (predicate(value)) return value
    assert.ok(
      performance.now() < end,
      `Condition timed out: ${JSON.stringify(value)}`,
    )
    await delay(20)
  }
}

/** Hold only the deadline under test; unrelated timers and I/O keep running. */
export function controlledTimer(t: TestContext, milliseconds: number) {
  const schedule = globalThis.setTimeout
  const pending: { timer: NodeJS.Timeout; fire: () => void }[] = []
  t.mock.method(globalThis, 'setTimeout', ((callback, ms, ...args) => {
    if (ms !== milliseconds) return schedule(callback, ms, ...args)
    const timer = schedule(() => {}, 2_147_483_647)
    pending.push({
      timer,
      fire: () => Reflect.apply(callback, undefined, args),
    })
    return timer
  }) as typeof setTimeout)
  t.after(() => pending.forEach(({ timer }) => clearTimeout(timer)))
  return {
    expire() {
      const item = pending.shift()
      assert.ok(item, `No ${milliseconds}ms timer was scheduled`)
      clearTimeout(item.timer)
      item.fire()
    },
  }
}

export function controlledTimeout(t: TestContext, milliseconds: number) {
  const timeout = AbortSignal.timeout
  const controller = new AbortController()
  let scheduled = false
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    if (ms !== milliseconds) return timeout(ms)
    scheduled = true
    return controller.signal
  })
  return {
    expire() {
      assert.ok(scheduled, `No ${milliseconds}ms signal was scheduled`)
      controller.abort(
        new DOMException('Test deadline expired', 'TimeoutError'),
      )
    },
  }
}

/** Observe the final query of a scheduler tick before asserting absence of work. */
export function schedulerTicks(t: TestContext, database: Database) {
  let completed = 0
  const query = database.query.bind(database)
  t.mock.method(database, 'query', (async (...args: unknown[]) => {
    const result = await Reflect.apply(query, undefined, args)
    if (
      typeof args[0] === 'string' &&
      args[0].includes('AND (NOT $2::boolean OR t.worktree_cleaned_at IS NULL)')
    )
      completed++
    return result
  }) as typeof database.query)
  return () => completed
}
