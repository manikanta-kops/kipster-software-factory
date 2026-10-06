import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { displayPath, setup, parsePort } from './setup.ts'
import { hiddenInput, pipedSecret } from './secrets/input.ts'
import { secretStore } from './secrets/store.ts'
import {
  DEFAULT_PORT,
  defaultHome,
  factoryVersion,
  readConfig,
} from './config.ts'
import { BUILT_IN_WORKFLOWS, loadLibrary } from './library/library.ts'
import { BUILT_WEB_APP, startFactory } from './server.ts'
import {
  isFactoryHealthy,
  isServiceLoaded,
  serviceLog,
  startService,
  stopService,
  waitForFactory,
} from './service.ts'
import { startManagedDatabase } from './store/cluster.ts'
import { openDatabase } from './store/database.ts'
import { migrate } from './store/migrate.ts'

const INSTALLER =
  'https://github.com/manikanta-kops/kipster-software-factory/releases/latest/download/install.sh'

const usage = `Usage: kf <command> [options]

Commands:
  setup     Guided setup; re-run to update current settings
  start     Run the factory in the background, now and at login (macOS)
  stop      Stop the background factory and remove it from login
  status    Show whether the background factory is running
  logs      Show the background factory's log (-f follows it)
  update    Install the latest release
  secret    set <name>, list, or remove <name> (values stay in the secret store)
  serve     Migrate the database, load workflows and serve the factory
  migrate   Apply pending database migrations
  check     Validate a directory of workflow files (default: built-in workflows)

Options:
  --home <dir>          Factory home with config.json (default: ~/.kipster-factory)
  --database-url <url>  Use this database instead of the private one setup creates
  --port <number>       Port to serve on (default: ${DEFAULT_PORT})
  --no-scheduler       Serve demo data or UI work without executing tickets
  --non-interactive    Setup without prompts (current values are defaults)
  --start              After setup, start the background factory
  --typesafe-stdin     Validate and save a TypeSafe key read from stdin
  --secret-backend file  Use the file backend explicitly (for tests/headless installs)
  --workflows <dir>     Workflow directory (default: built-in workflows)`

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      home: { type: 'string' },
      'database-url': { type: 'string' },
      port: { type: 'string' },
      workflows: { type: 'string' },
      'no-scheduler': { type: 'boolean' },
      'non-interactive': { type: 'boolean' },
      start: { type: 'boolean' },
      follow: { type: 'boolean', short: 'f' },
      version: { type: 'boolean', short: 'v' },
      'typesafe-stdin': { type: 'boolean' },
      'secret-backend': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const [command] = positionals
  if (values.version) {
    console.log(factoryVersion())
    return 0
  }
  if (values.help || !command) {
    console.log(usage)
    return command || values.help ? 0 : 2
  }

  const workflows = values.workflows ?? BUILT_IN_WORKFLOWS

  if (command === 'check') {
    const result = await loadLibrary(workflows)
    if (!result.ok) {
      console.error(result.errors.join('\n'))
      return 1
    }
    console.log(`${result.library.size} workflows are valid.`)
    return 0
  }

  const home = values.home ?? defaultHome()
  if (
    values['secret-backend'] !== undefined &&
    values['secret-backend'] !== 'file'
  )
    throw new Error(
      '--secret-backend accepts file only; the default uses the OS credential store.',
    )
  const secretBackend =
    values['secret-backend'] === 'file' ? ('file' as const) : undefined
  if (command === 'setup') {
    await setup({
      home,
      databaseUrl: values['database-url'],
      port: values.port,
      nonInteractive: values['non-interactive'],
      typeSafeStdin: values['typesafe-stdin'],
      secretBackend,
      start: values.start,
    })
    return 0
  }
  if (command === 'secret') {
    const [, action, name] = positionals
    const secrets = secretStore(home, secretBackend)
    if (action === 'list' && !name) {
      const entries = await secrets.list()
      console.log(
        entries.length
          ? entries.map((item) => `${item.name}\t${item.backend}`).join('\n')
          : 'No secrets stored.',
      )
    } else if (action === 'set' && name && positionals.length === 3) {
      const value = process.stdin.isTTY
        ? await hiddenInput(`Value for ${name} (hidden): `)
        : await pipedSecret()
      console.log(`${name}: saved in ${await secrets.set(name, value)}.`)
    } else if (action === 'remove' && name && positionals.length === 3) {
      await secrets.remove(name)
      console.log(`${name}: removed.`)
    } else throw new Error('Usage: kf secret set <name> | list | remove <name>')
    return 0
  }
  const settings = async () => {
    const port = values.port === undefined ? undefined : parsePort(values.port)
    const databaseUrl = values['database-url']
    if (databaseUrl !== undefined) {
      return { home, databaseUrl, port: port ?? DEFAULT_PORT }
    }
    const config = await readConfig(home)
    return {
      home,
      databaseUrl: config.databaseUrl,
      port: port ?? config.port,
      allowedOrigins: config.allowedOrigins,
      evidenceRetentionDays: config.evidenceRetentionDays,
      concurrency: config.concurrency,
      stepTimeoutMinutes: config.stepTimeoutMinutes,
      agents: config.agents,
    }
  }

  // Without a database URL the factory runs, and afterwards stops, its private cluster.
  const database = async (url: string | undefined) => {
    if (url !== undefined) return { url, stop: () => {} }
    return startManagedDatabase(home)
  }

  if (command === 'migrate') {
    const target = await database((await settings()).databaseUrl)
    const connection = openDatabase(target.url)
    try {
      const applied = await migrate(connection)
      console.log(
        applied.length === 0
          ? 'Database is up to date.'
          : `Applied migrations ${applied.join(', ')}.`,
      )
    } finally {
      await connection.end()
      target.stop()
    }
    return 0
  }

  if (command === 'serve') {
    const options = await settings()
    const target = await database(options.databaseUrl)
    let factory: Awaited<ReturnType<typeof startFactory>>
    try {
      factory = await startFactory({
        ...options,
        databaseUrl: target.url,
        workflows,
        webRoot: BUILT_WEB_APP,
        scheduler: !values['no-scheduler'],
      })
    } catch (error) {
      target.stop()
      throw error
    }
    console.log(`Kipster Software Factory is running at ${factory.url}`)
    await new Promise<void>((resolve) => {
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => resolve())
      }
    })
    await factory.close()
    target.stop()
    return 0
  }

  if (command === 'start') {
    const { port } = await readConfig(home)
    await startService(home)
    const url = `http://localhost:${port}`
    if (!(await waitForFactory(port)))
      throw new Error(
        `The factory did not start on ${url}. See kf logs for details.`,
      )
    console.log(`Kipster Software Factory is running at ${url}`)
    return 0
  }

  if (command === 'stop') {
    console.log(
      (await stopService(home))
        ? 'Kipster Software Factory stopped. Start it again with kf start.'
        : 'Kipster Software Factory is not running.',
    )
    return 0
  }

  if (command === 'status') {
    const config = await readConfig(home)
    const url = `http://localhost:${config.port}`
    const loaded = isServiceLoaded(home)
    const healthy = await isFactoryHealthy(config.port)
    console.log(
      [
        `Version   ${factoryVersion()}`,
        `Home      ${displayPath(home)}`,
        `Database  ${config.databaseUrl ? 'your PostgreSQL' : 'private PostgreSQL'}`,
        `Service   ${healthy ? `running at ${url}` : loaded ? 'started but not responding; see kf logs' : 'stopped; start it with kf start'}`,
      ].join('\n'),
    )
    return healthy ? 0 : 1
  }

  if (command === 'logs') {
    const log = serviceLog(home)
    if (!existsSync(log)) {
      console.log('No log yet. Start the factory with kf start.')
      return 0
    }
    const tail = spawn(
      'tail',
      ['-n', '200', ...(values.follow ? ['-f'] : []), log],
      { stdio: 'inherit' },
    )
    return new Promise((resolve) =>
      tail.once('exit', (code) => resolve(code ?? 0)),
    )
  }

  if (command === 'update') {
    const installer = spawn(
      '/bin/sh',
      ['-c', 'curl -fsSL "$1" | sh -s -- --home "$2"', 'kf', INSTALLER, home],
      { stdio: 'inherit' },
    )
    return new Promise((resolve) =>
      installer.once('exit', (code) => resolve(code ?? 1)),
    )
  }

  console.error(`Unknown command "${command}".\n\n${usage}`)
  return 2
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
