import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

export const DEFAULT_PORT = 4600

/** Where the factory keeps its configuration and, later, repository caches and evidence. */
export function defaultHome(): string {
  return join(homedir(), '.kipster-factory')
}

const configFile = z.strictObject({
  databaseUrl: z.string().min(1),
  port: z.int().min(1).max(65_535).default(DEFAULT_PORT),
})

export type FactoryConfig = z.infer<typeof configFile>

export async function readConfig(home: string): Promise<FactoryConfig> {
  const path = join(home, 'config.json')
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    throw new Error(
      `No configuration at ${path}. Create it with {"databaseUrl": "postgresql://…"}.`,
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
