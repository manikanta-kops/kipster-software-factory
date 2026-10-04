import type { Library } from '../library/library.ts'
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
