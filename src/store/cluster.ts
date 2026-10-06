// Private PostgreSQL clusters for the installed factory, development and tests. Clusters
// accept only Unix socket connections in a private directory, so other local users
// cannot connect. Programs come from the installed bundle's postgres/bin when present,
// otherwise from PostgreSQL 18 on PATH.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'

const SUPERUSER = 'factory'
const PORT = 5432
// A valid locale keeps the macOS postmaster from aborting at startup.
const env = { ...process.env, LC_ALL: 'C' }

/** Where an installed bundle keeps PostgreSQL, next to the app directory. */
const BUNDLED_POSTGRES = fileURLToPath(
  new URL('../../../postgres/bin/', import.meta.url),
)

/** The installed bundle's PostgreSQL programs, if this factory ships them. */
export function bundledPostgresBin(): string | undefined {
  return existsSync(join(BUNDLED_POSTGRES, 'pg_ctl'))
    ? BUNDLED_POSTGRES
    : undefined
}

export interface Cluster {
  readonly data: string
  readonly socketDirectory: string
  /** Directory with initdb and pg_ctl; PATH when absent. */
  readonly bin?: string | undefined
}

/** The cluster the factory runs for a home that has no database URL of its own. */
export function managedCluster(home: string): Cluster {
  // Unix socket paths are limited to about 100 bytes, so the socket lives under /tmp.
  const key = createHash('sha256').update(resolve(home)).digest('hex')
  return {
    data: join(home, 'postgres'),
    socketDirectory: join('/tmp', `kf-${key.slice(0, 12)}`),
    bin: bundledPostgresBin(),
  }
}

function run(cluster: Cluster, program: string, args: string[]) {
  const result = spawnSync(
    cluster.bin ? join(cluster.bin, program) : program,
    args,
    { env, encoding: 'utf8' },
  )
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
  if (socket.length > 100) {
    throw new Error(`Socket path is too long: ${socket}`)
  }
  mkdirSync(cluster.socketDirectory, { recursive: true, mode: 0o700 })
  if (!existsSync(join(cluster.data, 'PG_VERSION'))) {
    run(cluster, 'initdb', [
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
    run(cluster, 'pg_ctl', [
      '-D',
      cluster.data,
      '-l',
      log,
      '-w',
      '-t',
      '60',
      'start',
    ])
  } catch (error) {
    if (existsSync(log)) {
      ;(error as Error).message += `\n${readFileSync(log, 'utf8')}`
    }
    throw error
  }
}

export function isClusterRunning(cluster: Cluster): boolean {
  const result = spawnSync(
    cluster.bin ? join(cluster.bin, 'pg_ctl') : 'pg_ctl',
    ['-D', cluster.data, 'status'],
    { env },
  )
  return result.status === 0
}

export function stopCluster(cluster: Cluster): void {
  try {
    run(cluster, 'pg_ctl', [
      '-D',
      cluster.data,
      '-m',
      'fast',
      '-w',
      '-t',
      '60',
      'stop',
    ])
  } catch {
    run(cluster, 'pg_ctl', [
      '-D',
      cluster.data,
      '-m',
      'immediate',
      '-w',
      'stop',
    ])
  }
}

export function clusterUrl(cluster: Cluster, database = 'postgres'): string {
  return `postgresql://${SUPERUSER}@localhost:${PORT}/${database}?host=${encodeURIComponent(cluster.socketDirectory)}`
}

/** Creates the database in a running cluster if it does not exist yet. */
export async function ensureDatabase(
  cluster: Cluster,
  name: string,
): Promise<void> {
  const client = new Client({ connectionString: clusterUrl(cluster) })
  await client.connect()
  try {
    const { rowCount } = await client.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [name],
    )
    if (rowCount === 0) await client.query(`CREATE DATABASE "${name}"`)
  } finally {
    await client.end()
  }
}

export interface ManagedDatabase {
  readonly url: string
  /** Stops the cluster if this call started it. */
  stop(): void
}

/** Starts the home's private cluster when needed and returns the factory database. */
export async function startManagedDatabase(
  home: string,
): Promise<ManagedDatabase> {
  const cluster = managedCluster(home)
  const started = !isClusterRunning(cluster)
  if (started) startCluster(cluster)
  try {
    await ensureDatabase(cluster, 'factory')
  } catch (error) {
    if (started) stopCluster(cluster)
    throw error
  }
  return {
    url: clusterUrl(cluster, 'factory'),
    stop: () => {
      if (started) stopCluster(cluster)
    },
  }
}
