// Runs a command against a throwaway PostgreSQL cluster, then removes the cluster.
// The command receives the connection string as KSF_TEST_DATABASE_URL.
// Usage: node scripts/with-test-database.ts <command> [args...]
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { constants } from 'node:os'
import { join } from 'node:path'
import { clusterUrl, startCluster, stopCluster } from '../src/store/cluster.ts'

const [command, ...args] = process.argv.slice(2)
if (!command) {
  console.error('Usage: node scripts/with-test-database.ts <command> [args...]')
  process.exit(2)
}

// /tmp keeps the socket path short on macOS, where the default temp dir is long.
const root = mkdtempSync(join('/tmp', 'ksf-test-'))
const cluster = { data: join(root, 'data'), socketDirectory: root }
let started = false

function cleanup() {
  if (started) {
    try {
      stopCluster(cluster)
    } catch (error) {
      console.error((error as Error).message)
    }
    started = false
  }
  rmSync(root, { recursive: true, force: true })
}

let exitCode = 1
try {
  startCluster(cluster)
  started = true
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: { ...process.env, KSF_TEST_DATABASE_URL: clusterUrl(cluster) },
  })
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => child.kill(signal))
  }
  exitCode = await new Promise<number>((resolve) => {
    child.once('error', (error) => {
      console.error(error.message)
      resolve(1)
    })
    child.once('exit', (code, signal) =>
      resolve(code ?? 128 + (signal ? constants.signals[signal] : 0)),
    )
  })
} catch (error) {
  console.error((error as Error).message)
} finally {
  cleanup()
}
process.exit(exitCode)
