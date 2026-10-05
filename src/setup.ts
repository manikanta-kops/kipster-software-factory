import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DEFAULT_PORT } from './config.ts'
import { run } from './executors/process.ts'
import { openDatabase } from './store/database.ts'
import { migrate } from './store/migrate.ts'
import { hiddenInput, pipedSecret, prompt } from './secrets/input.ts'
import { secretStore, type SecretBackend } from './secrets/store.ts'
import { validateTypeSafeKey } from './decider/typesafe.ts'

export function parsePort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error('--port must be a number from 1 to 65535')
  return port
}
export async function setup(options: {
  home: string
  databaseUrl?: string | undefined
  port?: string | undefined
  nonInteractive?: boolean | undefined
  skipTypeSafe?: boolean | undefined
  typeSafeStdin?: boolean | undefined
  secretBackend?: SecretBackend | undefined
}): Promise<void> {
  const path = join(options.home, 'config.json')
  let current: Record<string, unknown> = {}
  try {
    current = JSON.parse(await readFile(path, 'utf8')) as Record<
      string,
      unknown
    >
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      // Invalid JSON diagnostics can include private configuration content.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        'Cannot read existing config.json; it has been preserved.',
      )
  }
  if (!current || typeof current !== 'object' || Array.isArray(current))
    throw new Error(
      'Existing config.json must be an object; it has been preserved.',
    )
  if (options.typeSafeStdin && options.skipTypeSafe)
    throw new Error('Choose --typesafe-stdin or --skip-typesafe.')
  const interactive = !options.nonInteractive && process.stdin.isTTY
  const databaseUrl =
    options.databaseUrl ??
    (interactive
      ? await prompt(
          'PostgreSQL database URL',
          String(current['databaseUrl'] ?? 'postgresql://localhost/factory'),
        )
      : String(current['databaseUrl'] ?? ''))
  if (!databaseUrl)
    throw new Error('Use --database-url for non-interactive setup.')
  const port = parsePort(
    options.port ??
      (interactive
        ? await prompt('Factory port', String(current['port'] ?? DEFAULT_PORT))
        : String(current['port'] ?? DEFAULT_PORT)),
  )
  const database = openDatabase(databaseUrl)
  try {
    await database.query('SELECT 1')
    const applied = await migrate(database)
    console.log(
      `Database connected. ${applied.length ? `Applied migrations ${applied.join(', ')}.` : 'Migrations are up to date.'}`,
    )
  } catch {
    throw new Error(
      'Database connection or migration failed. Check the database URL and PostgreSQL permissions; existing configuration was preserved.',
    )
  } finally {
    await database.end()
  }
  for (const [tool, consequence] of [
    ['git', 'repository checkout and ticket execution'],
    ['gh', 'GitHub checks and pull request actions'],
    ['codex', 'Codex agent steps'],
    ['claude', 'Claude agent steps'],
  ]) {
    try {
      await run(tool!, ['--version'], { signal: AbortSignal.timeout(10_000) })
      if (tool === 'gh')
        await run('gh', ['auth', 'status'], {
          signal: AbortSignal.timeout(10_000),
        })
      console.log(`${tool}: ready`)
    } catch {
      console.warn(
        `Warning: ${tool} is missing or unavailable${tool === 'gh' ? ' (check gh auth status)' : ''}; ${consequence} will not work.`,
      )
    }
  }
  await mkdir(options.home, { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}`
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ ...current, databaseUrl, port }, null, 2)}\n`,
      { mode: 0o600, flag: 'wx' },
    )
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => {})
  }
  console.log('Configuration saved.')
  console.log(
    'Optional: TypeSafe powers decision steps, such as judging whether a pull request is safe to auto-merge. Skip it and those decisions come to you.',
  )
  let key: string | undefined
  if (options.typeSafeStdin) key = await pipedSecret()
  else if (interactive && !options.skipTypeSafe)
    key = await hiddenInput('TypeSafe key (hidden; Enter skips): ')
  if (key?.trim()) {
    await validateTypeSafeKey(key).catch((error: Error) => {
      throw new Error(
        `${error.message}. The configuration is saved; store a key later with kf secret set typesafe.`,
      )
    })
    const backend = await secretStore(options.home, options.secretBackend).set(
      'typesafe',
      key,
    )
    console.log(`TypeSafe key validated and saved in ${backend}.`)
  } else
    console.log(
      'TypeSafe skipped; decision steps will ask the owner unless a key is already stored.',
    )
  console.log('Start the factory with kf serve.')
}
