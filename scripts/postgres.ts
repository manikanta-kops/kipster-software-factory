// Local PostgreSQL clusters for development and tests. Requires initdb and pg_ctl
// from PostgreSQL 18 on PATH. Clusters accept only Unix socket connections in a
// private directory, so other local users cannot connect.
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SUPERUSER = 'factory'
const PORT = 5432
// A valid locale keeps the macOS postmaster from aborting at startup.
const env = { ...process.env, LC_ALL: 'C' }

export interface Cluster {
  readonly data: string
  readonly socketDirectory: string
}

function run(program: string, args: string[]) {
  const result = spawnSync(program, args, { env, encoding: 'utf8' })
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    throw new Error(
      `${program} not found; add the PostgreSQL 18 bin directory to PATH`,
    )
  }
  if (result.status !== 0) {
    throw new Error(`${program} failed:\n${result.stderr || result.stdout}`)
  }
}

/** Creates the cluster on first use, then starts it. */
export function startCluster(cluster: Cluster): void {
  const socket = join(cluster.socketDirectory, `.s.PGSQL.${PORT}`)
  // Unix socket paths are limited to about 100 bytes.
  if (socket.length > 100) {
    throw new Error(`Socket path is too long: ${socket}`)
  }
  mkdirSync(cluster.socketDirectory, { recursive: true, mode: 0o700 })
  if (!existsSync(join(cluster.data, 'PG_VERSION'))) {
    run('initdb', [
      '-D',
      cluster.data,
      '-U',
      SUPERUSER,
      '-A',
      'trust',
      '-E',
      'UTF8',
      '--locale-provider=builtin',
      '--builtin-locale=C.UTF-8',
      '--no-sync',
      '--no-instructions',
    ])
    appendFileSync(
      join(cluster.data, 'postgresql.conf'),
      `\nlisten_addresses = ''\nport = ${PORT}\nunix_socket_directories = '${cluster.socketDirectory.replaceAll("'", "''")}'\n`,
    )
  }
  const log = join(cluster.data, 'server.log')
  try {
    run('pg_ctl', ['-D', cluster.data, '-l', log, '-w', '-t', '60', 'start'])
  } catch (error) {
    if (existsSync(log)) {
      ;(error as Error).message += `\n${readFileSync(log, 'utf8')}`
    }
    throw error
  }
}

export function isClusterRunning(cluster: Cluster): boolean {
  const result = spawnSync('pg_ctl', ['-D', cluster.data, 'status'], { env })
  return result.status === 0
}

export function stopCluster(cluster: Cluster): void {
  try {
    run('pg_ctl', ['-D', cluster.data, '-m', 'fast', '-w', '-t', '60', 'stop'])
  } catch {
    run('pg_ctl', ['-D', cluster.data, '-m', 'immediate', '-w', 'stop'])
  }
}

export function clusterUrl(cluster: Cluster, database = 'postgres'): string {
  return `postgresql://${SUPERUSER}@localhost:${PORT}/${database}?host=${encodeURIComponent(cluster.socketDirectory)}`
}
