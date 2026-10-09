// A lead's tasks and the child tickets that run them. Writes that touch a ticket's
// attempts lock that ticket first.
import { FactoryError } from '../domain/errors.ts'
import type { TicketAgents } from '../domain/settings.ts'
import { afterResult, waitForTasks } from '../domain/lifecycle.ts'
import type { LeadTask, TaskStatus, Ticket } from '../domain/records.ts'
import {
  isActiveTask,
  REPORTED_TASK_STATUSES,
  repeatedFailures,
} from '../domain/tasks.ts'
import { type Database, type Queryable, transaction } from './database.ts'
import { type NewEvent, recordEvents } from './events.ts'
import { TASK_SELECT, type TaskRow, taskEvent, toTask } from './task-records.ts'
import {
  apply,
  createTicketInTransaction,
  insertArtifacts,
  lockByAttempt,
  type NewTicket,
  openAttemptOf,
  setTicketStatus,
} from './tickets.ts'

export { getTaskOfChild, listTasks } from './task-records.ts'

/** Parks a running run-tasks attempt until a task needs the lead. */
export async function parkForTasks(
  database: Database,
  attemptId: number,
): Promise<void> {
  await transaction(database, async (connection) => {
    const locked = await lockByAttempt(connection, attemptId)
    const attempt = openAttemptOf(locked, attemptId)
    const status = waitForTasks(locked.workflow, locked.attempts)
    await connection.query(
      `UPDATE attempts SET status = 'waiting', waiting_for = 'tasks', waiting_since = now() WHERE id = $1`,
      [attemptId],
    )
    const events: NewEvent[] = [
      {
        ticketId: locked.id,
        kind: 'attempt.waiting',
        data: { attemptId, stepId: attempt.stepId, waitingFor: 'tasks' },
      },
    ]
    await setTicketStatus(connection, locked, status, attempt.stepId, events)
    await recordEvents(connection, events)
  })
}

/**
 * Creates the child ticket for a pending task. Returns null when the task already
 * started or ended, so a replayed start creates nothing.
 */
export async function startTask(
  database: Database,
  taskId: number,
  child: NewTicket,
  baseCommit: string | null,
): Promise<Ticket | null> {
  if (baseCommit !== null && !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(baseCommit))
    throw new FactoryError('invalid', 'Invalid commit object ID')
  return transaction(database, async (connection) => {
    const { rows } = await connection.query<{
      ticket_id: number
      key: string
      status: TaskStatus
    }>('SELECT ticket_id, key, status FROM tasks WHERE id = $1 FOR UPDATE', [
      taskId,
    ])
    const task = rows[0]
    if (!task || task.status !== 'pending') return null
    const parent = await connection.query<{
      lights_out: boolean
      agent_overrides: TicketAgents | null
    }>('SELECT lights_out, agent_overrides FROM tickets WHERE id = $1', [
      task.ticket_id,
    ])
    const ticket = await createTicketInTransaction(connection, {
      ...child,
      lightsOut: parent.rows[0]!.lights_out,
      agents: parent.rows[0]!.agent_overrides,
    })
    await connection.query(
      `UPDATE tasks SET status = 'running', child_ticket_id = $2, base_commit = $3, updated_at = now() WHERE id = $1`,
      [taskId, ticket.id, baseCommit],
    )
    await recordEvents(connection, [
      taskEvent(task.ticket_id, task.key, 'running', ticket.number),
    ])
    return ticket
  })
}

/** Moves a task on from pending, running or pr-ready; a task that already ended stays as it is. */
export async function updateTask(
  database: Database,
  taskId: number,
  status: TaskStatus,
  result: string | null,
): Promise<boolean> {
  return transaction(database, async (connection) => {
    const { rows } = await connection.query<{ ticket_id: number; key: string }>(
      `UPDATE tasks SET status = $2, result = coalesce($3, result), updated_at = now(),
         reported_status = CASE WHEN status = 'parked' AND $2 = 'running' THEN NULL ELSE reported_status END
       WHERE id = $1 AND status IN ('pending', 'running', 'parked', 'pr-ready') AND status <> $2
       RETURNING ticket_id, key`,
      [taskId, status, result],
    )
    const row = rows[0]
    if (!row) return false
    await recordEvents(connection, [taskEvent(row.ticket_id, row.key, status)])
    return true
  })
}

/**
 * Finishes a parked run-tasks attempt with a report when a task changed since the
 * lead last heard, or when nothing is left to wait for. Returns whether it reported.
 */
export async function reportTasks(
  database: Database,
  attemptId: number,
): Promise<boolean> {
  return transaction(database, async (connection) => {
    const locked = await lockByAttempt(connection, attemptId)
    const attempt = locked.attempts.at(-1)
    if (
      attempt?.id !== attemptId ||
      attempt.status !== 'waiting' ||
      attempt.waitingFor !== 'tasks'
    )
      return false
    const { rows } = await connection.query<TaskRow>(
      `${TASK_SELECT} WHERE k.ticket_id = $1 ORDER BY k.id FOR UPDATE OF k`,
      [locked.id],
    )
    const tasks = rows.map((row) => ({
      ...toTask(row),
      reported: row.reported_status,
    }))
    const changed = tasks.filter(
      (task) =>
        REPORTED_TASK_STATUSES.includes(task.status) &&
        task.status !== task.reported,
    )
    const active = tasks.filter(isActiveTask)
    if (changed.length === 0 && active.length > 0) return false
    const summary =
      changed.length > 0
        ? `Tasks changed: ${changed.map((task) => `${task.key} ${task.status}`).join(', ')}.${active.length ? ` Still waiting on ${active.length}.` : ' Nothing else is running.'}`
        : 'No task is running or waiting to merge.'
    const transition = afterResult(locked.workflow, locked.attempts, {
      outcome: 'reported',
      summary,
    })
    const events: NewEvent[] = []
    await insertArtifacts(
      connection,
      locked.id,
      attemptId,
      [
        {
          kind: 'note',
          title: 'Task report',
          content: taskReport(changed, tasks),
        },
      ],
      events,
    )
    if (changed.length)
      await connection.query(
        'UPDATE tasks SET reported_status = status WHERE id = ANY ($1)',
        [changed.map((task) => task.id)],
      )
    await apply(connection, locked, transition, { summary }, events)
    return true
  })
}

/** Parked run-tasks attempts' tickets, for the scheduler to advance. */
export async function listTaskWaits(
  database: Queryable,
): Promise<{ attemptId: number; ticketNumber: number }[]> {
  const { rows } = await database.query<{
    attempt_id: number
    number: number
  }>(
    `SELECT a.id AS attempt_id, t.number FROM attempts a JOIN tickets t ON t.id = a.ticket_id
     WHERE a.status = 'waiting' AND a.waiting_for = 'tasks' ORDER BY a.id`,
  )
  return rows.map((row) => ({
    attemptId: row.attempt_id,
    ticketNumber: row.number,
  }))
}

function taskReport(
  changed: readonly LeadTask[],
  tasks: readonly LeadTask[],
): string {
  const line = (task: LeadTask) =>
    `- **${task.key}** (${task.land}) ${task.status}${task.child ? ` — ticket #${task.child.number}` : ''}${task.child?.pullRequestUrl ? `, ${task.child.pullRequestUrl}` : ''}${task.result ? `: ${task.result}` : ''}`
  const others = tasks.filter((task) => !changed.includes(task))
  const repeated = repeatedFailures(tasks)
  return [
    changed.length ? `## Changed\n\n${changed.map(line).join('\n')}` : '',
    others.length ? `## Other tasks\n\n${others.map(line).join('\n')}` : '',
    repeated.length
      ? `## Repeated failure\n\n${repeated.map((group) => `- Same error ${group.count} times: ${group.tasks.join(', ')}. Classify the cause (task, plan or factory), record a decision artifact, and change the task or plan, or park that line of work and continue the rest. Do not retry with the same instructions.`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}
