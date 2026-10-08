// Reads of a lead's tasks, shared by the ticket store and the task store.
import type {
  LeadTask,
  ParentTask,
  TaskStatus,
  Ticket,
} from '../domain/records.ts'
import { replacements } from '../domain/tasks.ts'
import type { Queryable } from './database.ts'
import type { NewEvent } from './events.ts'

export const TASK_COLUMNS = `k.*,
    CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', c.id, 'number', c.number, 'status', c.status, 'branch', c.branch,
      'currentStep', c.current_step, 'pullRequestUrl', c.pull_request_url,
      'skippedSteps', c.skipped_steps,
      'waiting', CASE WHEN w.id IS NULL THEN NULL ELSE jsonb_build_object(
        'attemptId', w.id, 'stepId', w.step_id, 'for', w.waiting_for,
        'askReason', w.ask_reason, 'summary', w.summary,
        'since', to_char(w.waiting_since AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      END) END AS child`
export const TASK_FROM = `
  FROM tasks k
  LEFT JOIN tickets c ON c.id = k.child_ticket_id
  LEFT JOIN attempts w ON w.ticket_id = c.id AND w.status = 'waiting'`
export const TASK_SELECT = `SELECT ${TASK_COLUMNS} ${TASK_FROM}`

export interface TaskRow {
  id: number
  ticket_id: number
  attempt_id: number
  key: string
  title: string
  instructions: string
  land: 'branch' | 'pr'
  workflow: string
  agent: LeadTask['agent']
  status: TaskStatus
  reported_status: TaskStatus | null
  decision: LeadTask['decision']
  result: string | null
  base_commit: string | null
  child: LeadTask['child']
  created_at: Date
  updated_at: Date
}

export function toTask(row: TaskRow): LeadTask {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    attemptId: row.attempt_id,
    key: row.key,
    title: row.title,
    instructions: row.instructions,
    land: row.land,
    workflow: row.workflow,
    agent: row.agent,
    status: row.status,
    decision: row.decision,
    result: row.result,
    baseCommit: row.base_commit,
    child: row.child,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

export async function listTasks(
  database: Queryable,
  ticketId: number,
): Promise<LeadTask[]> {
  const { rows } = await database.query<TaskRow>(
    `${TASK_SELECT} WHERE k.ticket_id = $1 ORDER BY k.id`,
    [ticketId],
  )
  return rows.map(toTask)
}

/** The task a child ticket runs, with its lead ticket; null for other tickets. */
export async function getTaskOfChild(
  database: Queryable,
  childTicketId: number,
): Promise<{ task: LeadTask; parent: ParentTask } | null> {
  const { rows } = await database.query<
    TaskRow & {
      parent_id: number
      parent_number: number
      parent_title: string
      parent_status: Ticket['status']
    }
  >(
    `SELECT ${TASK_COLUMNS}, p.id AS parent_id, p.number AS parent_number,
            p.title AS parent_title, p.status AS parent_status
     ${TASK_FROM}
     JOIN tickets p ON p.id = k.ticket_id
     WHERE k.child_ticket_id = $1`,
    [childTicketId],
  )
  const row = rows[0]
  if (!row) return null
  return {
    task: toTask(row),
    parent: {
      key: row.key,
      land: row.land,
      status: row.status,
      parent: {
        id: row.parent_id,
        number: row.parent_number,
        title: row.parent_title,
        status: row.parent_status,
      },
    },
  }
}

export function taskEvent(
  ticketId: number,
  key: string,
  status: TaskStatus,
  childTicketNumber?: number,
): NewEvent {
  return {
    ticketId,
    kind: 'task.updated',
    data: {
      key,
      status,
      ...(childTicketNumber === undefined ? {} : { childTicketNumber }),
    },
  }
}

/** For each child ticket id, the task it runs, its lead's number and the child that replaced it. */
export async function listChildTasks(database: Queryable): Promise<
  Map<
    number,
    {
      readonly key: string
      readonly leadNumber: number
      readonly replacedBy: number | null
    }
  >
> {
  const { rows } = await database.query<{
    lead_id: number
    child_ticket_id: number | null
    child_number: number | null
    key: string
    status: TaskStatus
    created_at: Date
    lead_number: number
  }>(
    `SELECT k.ticket_id AS lead_id, k.child_ticket_id, c.number AS child_number,
            k.key, k.status, k.created_at, p.number AS lead_number
     FROM tasks k JOIN tickets p ON p.id = k.ticket_id
     LEFT JOIN tickets c ON c.id = k.child_ticket_id
     ORDER BY k.id`,
  )
  const leads = new Map<number, typeof rows>()
  for (const row of rows)
    leads.set(row.lead_id, [...(leads.get(row.lead_id) ?? []), row])
  const result = new Map<
    number,
    { key: string; leadNumber: number; replacedBy: number | null }
  >()
  for (const tasks of leads.values()) {
    const replaced = replacements(
      tasks.map((row) => ({
        key: row.key,
        status: row.status,
        createdAt: row.created_at.toISOString(),
        child: row.child_number === null ? null : { number: row.child_number },
      })),
    )
    for (const row of tasks)
      if (row.child_ticket_id !== null)
        result.set(row.child_ticket_id, {
          key: row.key,
          leadNumber: row.lead_number,
          replacedBy: replaced.get(row.key) ?? null,
        })
  }
  return result
}
