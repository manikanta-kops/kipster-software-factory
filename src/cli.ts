import { setup, parsePort } from './setup.ts'
import { hiddenInput, pipedSecret } from './secrets/input.ts'
import { secretStore } from './secrets/store.ts'
import { parseArgs } from 'node:util'
import { DEFAULT_PORT, defaultHome, readConfig } from './config.ts'
import { BUILT_IN_WORKFLOWS, loadLibrary } from './library/library.ts'
import { BUILT_WEB_APP, startFactory } from './server.ts'
import { openDatabase } from './store/database.ts'
import { migrate } from './store/migrate.ts'

const usage = `Usage: kf <command> [options]

Commands:
  setup     Guided installation; re-run to update current settings
  secret    set <name>, list, or remove <name> (values stay in the secret store)
  serve     Migrate the database, load workflows and serve the factory
  migrate   Apply pending database migrations
  check     Validate a directory of workflow files (default: built-in workflows)

Options:
  --home <dir>          Factory home with config.json (default: ~/.kipster-factory)
  --database-url <url>  Use this database instead of the one in config.json
  --port <number>       Port to serve on (default: ${DEFAULT_PORT})
  --no-scheduler       Serve demo data or UI work without executing tickets
  --non-interactive    Setup without prompts (current values are defaults)
  --skip-typesafe      Skip the optional TypeSafe setup
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
      'skip-typesafe': { type: 'boolean' },
      'typesafe-stdin': { type: 'boolean' },
      'secret-backend': { type: 'string' },
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
      skipTypeSafe: values['skip-typesafe'],
      typeSafeStdin: values['typesafe-stdin'],
      secretBackend,
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

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
