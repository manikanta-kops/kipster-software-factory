import { WorkflowInUse } from '../domain/errors.ts'
import type { Library, LibraryEntry } from '../library/library.ts'
import { type Database, transaction } from './database.ts'

/** Records every loaded workflow version; versions already recorded are left untouched. */
export async function recordWorkflowVersions(
  database: Database,
  library: Library,
): Promise<void> {
  await transaction(database, async (connection) => {
    for (const { workflow, version, source } of library.values()) {
      await connection.query(
        `INSERT INTO workflow_versions (name, version, source, definition)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (name, version) DO NOTHING`,
        [workflow.name, version, source, JSON.stringify(workflow)],
      )
    }
  })
}

/** Records an uploaded workflow version and makes it the current one for its name. */
export async function saveUploadedWorkflow(
  database: Database,
  { workflow, version, source }: LibraryEntry,
): Promise<void> {
  await transaction(database, async (connection) => {
    await connection.query(
      `INSERT INTO workflow_versions (name, version, source, definition)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (name, version) DO NOTHING`,
      [workflow.name, version, source, JSON.stringify(workflow)],
    )
    await connection.query(
      `INSERT INTO uploaded_workflows (name, version) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET version = $2, uploaded_at = now()`,
      [workflow.name, version],
    )
  })
}

/** The source of the current version of every uploaded workflow, by name. */
export async function listUploadedWorkflows(
  database: Database,
): Promise<readonly { readonly name: string; readonly source: string }[]> {
  const { rows } = await database.query<{ name: string; source: string }>(
    `SELECT u.name, v.source
     FROM uploaded_workflows u
     JOIN workflow_versions v ON v.name = u.name AND v.version = u.version
     ORDER BY u.name`,
  )
  return rows
}

/** Workflow names retained by stored tickets, including retired files. */
export async function ticketWorkflowNames(
  database: Database,
): Promise<readonly string[]> {
  const { rows } = await database.query<{ name: string }>(
    'SELECT DISTINCT workflow_name AS name FROM tickets ORDER BY name',
  )
  return rows.map((row) => row.name)
}

/**
 * Stops offering an uploaded workflow. Its stored versions stay, so tickets
 * that ran it keep their history. Refused while an unfinished ticket runs it or
 * an unfinished lead has a task that will. Returns false when no upload has
 * that name.
 */
export async function removeUploadedWorkflow(
  database: Database,
  name: string,
): Promise<boolean> {
  return transaction(database, async (connection) => {
    const { rowCount } = await connection.query(
      'SELECT 1 FROM uploaded_workflows WHERE name = $1 FOR UPDATE',
      [name],
    )
    if (!rowCount) return false
    const { rows } = await connection.query<{ number: number }>(
      `SELECT number FROM tickets
       WHERE workflow_name = $1 AND status NOT IN ('done', 'cancelled')
       UNION
       SELECT lead.number FROM tasks
       JOIN tickets lead ON lead.id = tasks.ticket_id
       WHERE tasks.workflow = $1 AND lead.status NOT IN ('done', 'cancelled')
       ORDER BY number`,
      [name],
    )
    if (rows.length)
      throw new WorkflowInUse(
        name,
        rows.map((row) => row.number),
      )
    await connection.query('DELETE FROM uploaded_workflows WHERE name = $1', [
      name,
    ])
    return true
  })
}
