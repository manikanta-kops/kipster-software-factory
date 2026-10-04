// Starts a local development factory: a persistent PostgreSQL cluster under .local/,
// the API with file watching, and the Vite dev server for the web app.
import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { DEFAULT_PORT } from '../src/config.ts'
import { clusterUrl, startCluster, stopCluster } from './postgres.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const repoKey = createHash('sha256').update(root).digest('hex').slice(0, 8)
const cluster = {
  data: join(root, '.local', 'postgres'),
  socketDirectory: join('/tmp', `ksf-dev-${repoKey}`),
}
const DATABASE = 'factory'

startCluster(cluster)
await ensureDatabase()

const children: ChildProcess[] = [
  spawn(
    process.execPath,
    [
      '--watch-path=src',
      '--watch-path=workflows',
      'src/cli.ts',
      'serve',
      '--database-url',
      clusterUrl(cluster, DATABASE),
      '--port',
      String(DEFAULT_PORT),
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

async function ensureDatabase() {
  const client = new Client({ connectionString: clusterUrl(cluster) })
  await client.connect()
  try {
    const { rowCount } = await client.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [DATABASE],
    )
    if (rowCount === 0) await client.query(`CREATE DATABASE ${DATABASE}`)
  } finally {
    await client.end()
  }
}
