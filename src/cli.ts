import { parseArgs } from 'node:util'
import { DEFAULT_PORT, defaultHome, readConfig } from './config.ts'
import { BUILT_IN_WORKFLOWS, loadLibrary } from './library/library.ts'
import { BUILT_WEB_APP, startFactory } from './server.ts'
import { openDatabase } from './store/database.ts'
import { migrate } from './store/migrate.ts'

const usage = `Usage: kf <command> [options]

Commands:
  serve     Migrate the database, load workflows and serve the factory
  migrate   Apply pending database migrations
  check     Validate a directory of workflow files (default: built-in workflows)

Options:
  --home <dir>          Factory home with config.json (default: ~/.kipster-factory)
  --database-url <url>  Use this database instead of the one in config.json
  --port <number>       Port to serve on (default: ${DEFAULT_PORT})
  --no-scheduler       Serve demo data or UI work without executing tickets
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
      help: { type: 'boolean', short: 'h' },
    },
  })
  const [command] = positionals
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
      concurrency: config.concurrency,
      stepTimeoutMinutes: config.stepTimeoutMinutes,
      agents: config.agents,
    }
  }

  if (command === 'migrate') {
    const database = openDatabase((await settings()).databaseUrl)
    try {
      const applied = await migrate(database)
      console.log(
        applied.length === 0
          ? 'Database is up to date.'
          : `Applied migrations ${applied.join(', ')}.`,
      )
    } finally {
      await database.end()
    }
    return 0
  }

  if (command === 'serve') {
    const factory = await startFactory({
      ...(await settings()),
      workflows,
      webRoot: BUILT_WEB_APP,
      scheduler: !values['no-scheduler'],
    })
    console.log(`Kipster Software Factory is running at ${factory.url}`)
    await new Promise<void>((resolve) => {
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => resolve())
      }
    })
    await factory.close()
    return 0
  }

  console.error(`Unknown command "${command}".\n\n${usage}`)
  return 2
}

function parsePort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`--port must be a number from 1 to 65535, not "${value}"`)
  }
  return port
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
