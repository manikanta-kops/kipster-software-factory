import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import * as ui from '@clack/prompts'
import { DEFAULT_PORT, factoryVersion } from './config.ts'
import { run } from './executors/process.ts'
import { BUILT_IN_WORKFLOWS, loadLibrary } from './library/library.ts'
import { startService, waitForFactory } from './service.ts'
import { startManagedDatabase } from './store/cluster.ts'
import { openDatabase } from './store/database.ts'
import { migrate } from './store/migrate.ts'
import { pipedSecret } from './secrets/input.ts'
import { secretStore, type SecretBackend } from './secrets/store.ts'
import { validateTypeSafeKey } from './decider/typesafe.ts'

export function parsePort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error('--port must be a number from 1 to 65535')
  return port
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const server = createServer()
    server.once('error', () => done(false))
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)))
  })
}

/** The first port from `preferred` that nothing on this machine listens on. */
export async function freePort(preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + 50 && port <= 65_535; port++)
    if (await isPortFree(port)) return port
  throw new Error(
    `Ports ${preferred}-${preferred + 49} are in use; choose one with --port.`,
  )
}

export function displayPath(path: string): string {
  const home = homedir()
  return path === home || path.startsWith(`${home}/`)
    ? `~${path.slice(home.length)}`
    : path
}

const pad = (label: string) => label.padEnd(9)

async function version(tool: string): Promise<string | undefined> {
  try {
    const output = await run(tool, ['--version'], {
      signal: AbortSignal.timeout(10_000),
    })
    return output.split('\n')[0]?.match(/\d+(\.\d+)+/)?.[0] ?? 'installed'
  } catch {
    return undefined
  }
}

interface GitHubAccount {
  readonly login: string
  readonly host: string
  readonly scopes: readonly string[]
}

async function gitHubAccount(): Promise<GitHubAccount | undefined> {
  try {
    const output = await run(
      'gh',
      ['auth', 'status', '--active', '--json', 'hosts'],
      { signal: AbortSignal.timeout(10_000) },
    )
    const hosts = (
      JSON.parse(output) as {
        hosts: Record<
          string,
          { state: string; active: boolean; login: string; scopes?: string }[]
        >
      }
    ).hosts
    for (const [host, accounts] of Object.entries(hosts))
      for (const account of accounts)
        if (account.active && account.state === 'success')
          return {
            login: account.login,
            host,
            scopes: (account.scopes ?? '')
              .split(',')
              .map((scope) => scope.trim())
              .filter(Boolean),
          }
  } catch {
    // Older gh versions without --json report as signed out; gh auth status explains.
  }
  return undefined
}

function answer<T>(value: T | symbol): T {
  if (ui.isCancel(value)) throw new Error('Setup cancelled.')
  return value as T
}

export async function setup(options: {
  home: string
  databaseUrl?: string | undefined
  port?: string | undefined
  nonInteractive?: boolean | undefined
  typeSafeStdin?: boolean | undefined
  secretBackend?: SecretBackend | undefined
  start?: boolean | undefined
}): Promise<void> {
  const home = resolve(options.home)
  const path = join(home, 'config.json')
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
  const interactive = !options.nonInteractive && Boolean(process.stdin.isTTY)
  const explicitPort =
    options.port === undefined ? undefined : parsePort(options.port)
  const loaded = await loadLibrary(BUILT_IN_WORKFLOWS)
  if (!loaded.ok)
    throw new Error(
      `Built-in workflows are invalid:\n  ${loaded.errors.join('\n  ')}`,
    )

  ui.intro(`Kipster Software Factory  v${factoryVersion()}`)
  ui.log.step('Checking your tools')
  const git = await version('git')
  if (git) ui.log.success(`${pad('git')}${git}`)
  else
    ui.log.warn(
      `${pad('git')}not found; repository checkout and ticket execution will not work.`,
    )

  if (!(await version('gh')))
    ui.log.warn(
      `${pad('GitHub')}gh is not installed; GitHub checks and pull requests will not work. Install it with: brew install gh`,
    )
  else {
    let account = await gitHubAccount()
    if (
      !account &&
      interactive &&
      answer(
        await ui.confirm({
          message: 'GitHub CLI is not signed in. Sign in now?',
          initialValue: true,
        }),
      )
    ) {
      spawnSync('gh', ['auth', 'login'], { stdio: 'inherit' })
      account = await gitHubAccount()
    }
    if (!account)
      ui.log.warn(
        `${pad('GitHub')}not signed in; GitHub checks and pull requests will not work. Run: gh auth login`,
      )
    else {
      ui.log.success(
        `${pad('GitHub')}signed in as @${account.login}  (${account.host}${account.scopes.length ? ` · ${account.scopes.join(', ')}` : ''})`,
      )
      const missing = ['repo', 'workflow'].filter(
        (scope) => account.scopes.length && !account.scopes.includes(scope),
      )
      if (missing.length)
        ui.log.warn(
          `${pad('')}Missing scope ${missing.join(', ')}; pull requests may fail. Run: gh auth refresh -s repo,workflow`,
        )
    }
  }

  const agents: ('codex' | 'claude')[] = []
  for (const [tool, name] of [
    ['codex', 'Codex'],
    ['claude', 'Claude'],
  ] as const) {
    const found = await version(tool)
    if (found) {
      agents.push(tool)
      ui.log.success(`${pad(name)}${found}`)
    } else
      ui.log.warn(`${pad(name)}not found; ${name} agent steps will not work.`)
  }
  if (!agents.length)
    ui.log.warn('Install Codex or Claude Code so agents can work on tickets.')

  let agentDefault: 'codex' | 'claude' | undefined
  if (current['agents'] === undefined) {
    if (agents.length === 2 && interactive)
      agentDefault = answer<'codex' | 'claude'>(
        await ui.select({
          message: 'Which agent should run steps by default?',
          options: [
            { value: 'codex' as const, label: 'Codex', hint: 'recommended' },
            { value: 'claude' as const, label: 'Claude' },
          ],
          initialValue: 'codex' as const,
        }),
      )
    else if (agents.length === 1) agentDefault = agents[0]
  }

  await mkdir(home, { recursive: true, mode: 0o700 })
  const databaseUrl =
    options.databaseUrl ??
    (typeof current['databaseUrl'] === 'string'
      ? current['databaseUrl']
      : undefined)
  // Spinners redraw with terminal escapes, which garble logs and piped output.
  const progress = process.stdout.isTTY
    ? ui.spinner()
    : {
        start: () => {},
        stop: (message: string) => ui.log.success(message),
        error: (message: string) => ui.log.error(message),
      }
  progress.start(
    databaseUrl ? 'Connecting to the database' : 'Preparing the database',
  )
  const managed = databaseUrl
    ? undefined
    : await startManagedDatabase(home).catch((error: Error) => {
        progress.error('The private database could not start')
        throw error
      })
  const database = openDatabase(databaseUrl ?? managed!.url)
  let applied: number[]
  try {
    await database.query('SELECT 1')
    applied = await migrate(database)
  } catch {
    progress.error('Database connection or migration failed')
    throw new Error(
      'Database connection or migration failed. Check the database URL and PostgreSQL permissions; existing configuration was preserved.',
    )
  } finally {
    await database.end()
    managed?.stop()
  }
  progress.stop(
    `${pad('Database')}${databaseUrl ? 'your PostgreSQL' : `private PostgreSQL in ${displayPath(join(home, 'postgres'))}`}  ·  ${applied.length ? `${applied.length} migrations applied` : 'up to date'}`,
  )

  const configuredPort =
    typeof current['port'] === 'number' ? current['port'] : undefined
  const port = explicitPort ?? configuredPort ?? (await freePort(DEFAULT_PORT))
  if (port !== (explicitPort ?? configuredPort ?? DEFAULT_PORT))
    ui.log.info(`${pad('Port')}${DEFAULT_PORT} is in use; using ${port}.`)

  const temporary = `${path}.${randomUUID()}`
  try {
    await writeFile(
      temporary,
      `${JSON.stringify(
        {
          ...current,
          ...(options.databaseUrl ? { databaseUrl: options.databaseUrl } : {}),
          port,
          ...(agentDefault
            ? { agents: { default: { cli: agentDefault }, roles: {} } }
            : {}),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600, flag: 'wx' },
    )
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => {})
  }
  ui.log.success(`${pad('Config')}${displayPath(path)}`)

  if (options.typeSafeStdin) {
    const key = await pipedSecret()
    await validateTypeSafeKey(key).catch((error: Error) => {
      throw new Error(
        `${error.message}. The configuration is saved; store a key later with kf secret set typesafe.`,
      )
    })
    const backend = await secretStore(home, options.secretBackend).set(
      'typesafe',
      key,
    )
    ui.log.success(`${pad('TypeSafe')}key validated and saved in ${backend}.`)
  }

  const url = `http://localhost:${port}`
  if (!options.start) {
    ui.outro(`Configured. Start the factory with: kf start`)
    return
  }
  progress.start('Starting the factory')
  await startService(home)
  if (!(await waitForFactory(port))) {
    progress.error('The factory did not respond')
    throw new Error(
      `The factory did not start on ${url}. See kf logs for details.`,
    )
  }
  progress.stop(`${pad('Service')}running at ${url}  ·  starts at login`)
  ui.outro(
    `Ready: ${url}\n   Next: onboard a repository from the web app.\n   Commands: kf status · kf logs · kf stop · kf update`,
  )
}
