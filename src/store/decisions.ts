import type {
  DecisionInput,
  DecisionRecord,
  DecisionStepCounts,
} from '../domain/decisions.ts'
import { FactoryError } from '../domain/errors.ts'
import type { Queryable } from './database.ts'

interface Row {
  id: number
  purpose: 'step' | 'merge'
  merge_requested_at: Date | null
  merge_succeeded_at: Date | null
  merge_error: string | null
  ticket_id: number
  number: number
  attempt_id: number
  step_id: string
  workflow_name: string
  workflow_version: string
  pending: boolean
  input: DecisionInput
  final_option: string | null
  decided_by: 'model' | 'owner' | null
  overridden: boolean
  created_at: Date
  decided_at: Date | null
}
const select = `SELECT d.*, t.number, t.workflow_name, t.workflow_version, a.step_id,
  ((d.purpose = 'step' AND a.status = 'waiting' AND a.waiting_for = 'decision') OR
    (d.purpose = 'merge' AND d.final_option IS NULL
     AND d.input->>'band' = 'confirm' AND d.input->'answer'->>'choice' = 'merge'
     AND EXISTS (SELECT 1 FROM attempts waiting WHERE waiting.ticket_id = t.id
       AND waiting.status = 'waiting' AND waiting.waiting_for = 'pull-request-merge')
     AND EXISTS (SELECT 1 FROM merge_gates g JOIN repositories r ON r.id = t.repository_id
       WHERE g.ticket_id = t.id AND d.head_commit = g.evaluation->'facts'->>'head'
       AND r.auto_merge AND g.evaluation->>'ready' = 'true' AND g.evaluation->'needsOwner' = '[]'::jsonb))
  ) AS pending FROM decision_log d JOIN tickets t ON t.id = d.ticket_id JOIN attempts a ON a.id = d.attempt_id`

function record(row: Row): DecisionRecord {
  return {
    ...row.input,
    purpose: row.purpose,
    mergeRequestedAt: row.merge_requested_at?.toISOString() ?? null,
    mergeSucceededAt: row.merge_succeeded_at?.toISOString() ?? null,
    mergeError: row.merge_error,
    id: row.id,
    ticketId: row.ticket_id,
    ticketNumber: row.number,
    attemptId: row.attempt_id,
    stepId: row.step_id,
    workflow: row.workflow_name,
    workflowVersion: row.workflow_version,
    pending: row.pending,
    finalOption: row.final_option,
    decidedBy: row.decided_by,
    overridden: row.overridden,
    createdAt: row.created_at.toISOString(),
    decidedAt: row.decided_at?.toISOString() ?? null,
  }
}
export async function listDecisions(
  database: Queryable,
  ticketId?: number,
): Promise<DecisionRecord[]> {
  const { rows } = await database.query<Row>(
    `${select} WHERE ($1::integer IS NULL OR d.ticket_id = $1) ORDER BY d.id DESC
    LIMIT CASE WHEN $1::integer IS NULL THEN 100 END`,
    [ticketId ?? null],
  )
  return rows.map(record)
}
export async function decisionCounts(
  database: Queryable,
): Promise<DecisionStepCounts[]> {
  const { rows } = await database.query<{
    workflow: string
    workflowVersion: string
    stepId: string
    total: number
    ownerDecisions: number
    overrides: number
  }>(`
    SELECT t.workflow_name AS workflow, t.workflow_version AS "workflowVersion", a.step_id AS "stepId", count(*)::integer AS total,
      count(*) FILTER (WHERE d.decided_by = 'owner')::integer AS "ownerDecisions", count(*) FILTER (WHERE d.overridden)::integer AS overrides
    FROM decision_log d JOIN tickets t ON t.id = d.ticket_id JOIN attempts a ON a.id = d.attempt_id
    GROUP BY t.workflow_name, t.workflow_version, a.step_id ORDER BY overrides DESC, total DESC, workflow, "stepId"`)
  return rows
}
export async function insertDecision(
  database: Queryable,
  ticketId: number,
  attemptId: number,
  input: DecisionInput,
): Promise<void> {
  const final = input.band === 'acted' ? input.answer!.choice : null
  await database.query(
    `INSERT INTO decision_log(ticket_id, attempt_id, input, final_option, decided_by, decided_at)
    VALUES ($1, $2, $3, $4, $5, CASE WHEN $4::text IS NOT NULL THEN now() END)`,
    [ticketId, attemptId, JSON.stringify(input), final, final ? 'model' : null],
  )
}
export async function finishDecision(
  database: Queryable,
  attemptId: number,
  choice: string,
): Promise<void> {
  const { rows } = await database.query<{ input: DecisionInput }>(
    "SELECT input FROM decision_log WHERE attempt_id = $1 AND purpose = 'step' AND final_option IS NULL",
    [attemptId],
  )
  const input = rows[0]?.input
  if (!input)
    throw new FactoryError(
      'conflict',
      'This decision is no longer waiting for the owner',
    )
  if (!Object.hasOwn(input.options, choice))
    throw new FactoryError('invalid', 'Choose one of the decision options')
  await database.query(
    `UPDATE decision_log SET final_option = $2, decided_by = 'owner', overridden = $3, decided_at = now() WHERE attempt_id = $1 AND purpose = 'step'`,
    [
      attemptId,
      choice,
      input.answer !== null && input.answer.choice !== choice,
    ],
  )
}
