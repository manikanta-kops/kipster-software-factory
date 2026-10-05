// Starts a local development factory: a persistent PostgreSQL cluster under .local/,
// the API with optional file watching, and the Vite dev server for the web app.
import { type ChildProcess, spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { join } from 'node:path'
import { DEFAULT_PORT } from '../src/config.ts'
import {
  devCluster as cluster,
  devDatabaseUrl,
  ensureDevDatabase,
  root,
} from './dev-database.ts'
import { startCluster, stopCluster } from './postgres.ts'
import { run } from '../src/executors/process.ts'

const { values } = parseArgs({
  options: {
    watch: { type: 'boolean' },
    'no-scheduler': { type: 'boolean' },
    home: { type: 'string' },
  },
})

// Vite mutates NODE_ENV; build separately so agents still install dev dependencies.
console.log(
  await run(
    process.execPath,
    [join(root, 'node_modules/vite/bin/vite.js'), 'build'],
    {
      cwd: root,
    },
  ),
)
startCluster(cluster)
await ensureDevDatabase()

const children: ChildProcess[] = [
  spawn(
    process.execPath,
    [
      ...(values.watch ? ['--watch-path=src', '--watch-path=workflows'] : []),
      'src/cli.ts',
      'serve',
      '--database-url',
      devDatabaseUrl,
      '--port',
      String(DEFAULT_PORT),
      ...(values['no-scheduler'] ? ['--no-scheduler'] : []),
      '--home',
      values.home ?? join(root, '.local', 'factory'),
    ],
    { cwd: root, stdio: 'inherit' },
  ),
  spawn(join(root, 'node_modules', '.bin', 'vite'), [], {
    cwd: root,
    stdio: 'inherit',
  }),
]

let stopping = false
function stop() {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill('SIGTERM')
  stopCluster(cluster)
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, stop)
}
for (const child of children) {
  child.once('exit', (code) => {
    if (!stopping) {
      console.error(`A development process exited (code ${code}); stopping.`)
      stop()
      process.exitCode = 1
    }
  })
}
