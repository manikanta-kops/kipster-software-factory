import { z } from 'zod'
import { type Settings, settingsSchema } from '../domain/settings.ts'
import type { Database } from './database.ts'

export interface EffectiveSettings {
  readonly settings: Settings
  /** `config`: config.json's values (or defaults); `saved`: edited in the web app. */
  readonly source: 'config' | 'saved'
  readonly updatedAt: string | null
}

/** The saved settings, or the fallback from config.json when none are saved or the row is unreadable. */
export async function effectiveSettings(
  database: Database,
  fallback: Settings,
): Promise<EffectiveSettings> {
  const { rows } = await database.query<{ engine: unknown; updated_at: Date }>(
    'SELECT engine, updated_at FROM settings',
  )
  const row = rows[0]
  if (!row) return { settings: fallback, source: 'config', updatedAt: null }
  const parsed = settingsSchema.safeParse(row.engine)
  if (!parsed.success) {
    console.error(
      `Saved settings are invalid; using config.json values: ${z.prettifyError(parsed.error)}`,
    )
    return { settings: fallback, source: 'config', updatedAt: null }
  }
  return {
    settings: parsed.data,
    source: 'saved',
    updatedAt: row.updated_at.toISOString(),
  }
}

export async function saveSettings(
  database: Database,
  settings: Settings,
): Promise<void> {
  await database.query(
    `INSERT INTO settings (id, engine) VALUES (true, $1)
     ON CONFLICT (id) DO UPDATE SET engine = $1, updated_at = now()`,
    [JSON.stringify(settings)],
  )
}

export async function hasSavedSettings(database: Database): Promise<boolean> {
  const { rows } = await database.query('SELECT 1 FROM settings')
  return rows.length > 0
}
