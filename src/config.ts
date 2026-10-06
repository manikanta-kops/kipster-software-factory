import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { agentChoiceSchema } from './domain/catalog.ts'

export const DEFAULT_PORT = 4600

/** Browser origins allowed to call the API: the Vite dev server and the Tauri desktop shell. */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
]

export function factoryVersion(): string {
  const manifest = new URL('../package.json', import.meta.url)
  return (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string })
    .version
}

/** Where the factory keeps its configuration and, later, repository caches and evidence. */
export function defaultHome(): string {
  return join(homedir(), '.kipster-factory')
}

export const agentConfig = agentChoiceSchema
export const engineConfig = z.object({
  evidenceRetentionDays: z.int().positive().default(30),
  concurrency: z.int().positive().default(2),
  stepTimeoutMinutes: z.number().positive().default(60),
  agents: z
    .strictObject({
      default: agentConfig.default({ cli: 'codex' }),
      roles: z
        .partialRecord(
          z.enum([
            'planner',
            'builder',
            'reviewer',
            'writer',
            'tester',
            'reproducer',
            'onboarder',
            'lead',
          ]),
          agentConfig,
        )
        .default({}),
      /** The agents a lead may choose for a task. Empty: tasks use the role settings. */
      allowed: z.array(agentConfig).default([]),
    })
    .default({ default: { cli: 'codex' }, roles: {}, allowed: [] }),
})
export type EngineConfig = z.infer<typeof engineConfig>
export type AgentConfig = z.infer<typeof agentConfig>

const configFile = z.strictObject({
  ...engineConfig.shape,
  /** Absent: the factory runs its own PostgreSQL cluster in the home directory. */
  databaseUrl: z.string().min(1).optional(),
  port: z.int().min(1).max(65_535).default(DEFAULT_PORT),
  allowedOrigins: z
    .array(z.string().min(1))
    .default(() => [...DEFAULT_ALLOWED_ORIGINS]),
})

export type FactoryConfig = z.infer<typeof configFile>

export async function readConfig(home: string): Promise<FactoryConfig> {
  const path = join(home, 'config.json')
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    throw new Error(
      `No configuration at ${path}. Run kf setup --home <directory> to configure the factory.`,
    )
  }
  const parsed = configFile.safeParse(JSON.parse(text))
  if (!parsed.success) {
    throw new Error(
      `Invalid configuration in ${path}: ${z.prettifyError(parsed.error)}`,
    )
  }
  return parsed.data
}
