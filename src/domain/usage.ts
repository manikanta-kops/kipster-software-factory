// What step runs cost in tokens and time. Shared by the server and the web app.
import type { Attempt, LeadTask } from './records.ts'

/** Tokens one agent run reported. Input includes cached input. */
export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

/** Totals over finished step runs. Tokens are null when no run reported any. */
export interface UsageTotals {
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly durationMs: number
  /** Finished step runs counted. */
  readonly steps: number
}

/** One lead task's totals over its child ticket's finished step runs. */
export interface TaskUsage {
  readonly taskId: number
  readonly key: string
  readonly title: string
  readonly status: LeadTask['status']
  readonly ticketNumber: number
  readonly usage: UsageTotals
}

export interface TicketUsage {
  /** The ticket's own finished step runs plus every task's totals. */
  readonly total: UsageTotals
  /** A lead ticket's tasks that have a child ticket, oldest first. */
  readonly tasks: readonly TaskUsage[]
}

type Run = Pick<
  Attempt,
  'startedAt' | 'finishedAt' | 'inputTokens' | 'outputTokens'
>

/** A step run that started and finished; only these have a duration. */
export function isFinishedRun(attempt: Run): boolean {
  return attempt.startedAt !== null && attempt.finishedAt !== null
}

export function runDuration(attempt: Run): number | null {
  if (!isFinishedRun(attempt)) return null
  return Math.max(
    0,
    Date.parse(attempt.finishedAt!) - Date.parse(attempt.startedAt!),
  )
}

export function usageTotals(attempts: readonly Run[]): UsageTotals {
  return attempts.filter(isFinishedRun).reduce(
    (total, attempt) =>
      addTotals(total, {
        inputTokens: attempt.inputTokens,
        outputTokens: attempt.outputTokens,
        durationMs: runDuration(attempt)!,
        steps: 1,
      }),
    EMPTY,
  )
}

export function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    inputTokens: addNullable(a.inputTokens, b.inputTokens),
    outputTokens: addNullable(a.outputTokens, b.outputTokens),
    durationMs: a.durationMs + b.durationMs,
    steps: a.steps + b.steps,
  }
}

export function ticketUsage(
  attempts: readonly Run[],
  tasks: readonly LeadTask[],
  taskAttempts: ReadonlyMap<number, readonly Run[]>,
): TicketUsage {
  const rows = tasks.flatMap((task): TaskUsage[] =>
    task.child
      ? [
          {
            taskId: task.id,
            key: task.key,
            title: task.title,
            status: task.status,
            ticketNumber: task.child.number,
            usage: usageTotals(taskAttempts.get(task.id) ?? []),
          },
        ]
      : [],
  )
  return {
    total: rows.reduce(
      (total, row) => addTotals(total, row.usage),
      usageTotals(attempts),
    ),
    tasks: rows,
  }
}

/** Token counts as `950`, `35.7k`, `121k` or `1.2M`. */
export function compactNumber(value: number): string {
  if (value < 1000) return String(value)
  const units = [
    ['k', 1e3],
    ['M', 1e6],
    ['B', 1e9],
  ] as const
  let text = ''
  for (const [unit, size] of units) {
    const scaled = value / size
    const digits =
      scaled < 100
        ? scaled.toFixed(1).replace(/\.0$/, '')
        : String(Math.round(scaled))
    text = digits + unit
    if (Number(digits) < 1000) break
  }
  return text
}

/** Durations as `46s`, `7m 40s` or `1h 12m`. */
export function compactDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

const EMPTY: UsageTotals = {
  inputTokens: null,
  outputTokens: null,
  durationMs: 0,
  steps: 0,
}

function addNullable(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null ? a : a + b
}
