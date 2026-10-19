import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const RELEASES =
  'https://github.com/manikanta-kops/kipster-software-factory/releases'

/** The newest release's version, read from where GitHub redirects /releases/latest. */
export async function latestRelease(
  signal?: AbortSignal,
  releases = RELEASES,
): Promise<string> {
  const response = await fetch(`${releases}/latest`, {
    method: 'HEAD',
    redirect: 'manual',
    signal: signal ?? AbortSignal.timeout(15_000),
  })
  const location = response.headers.get('location') ?? ''
  const version = /\/releases\/tag\/v([0-9A-Za-z.-]+)$/.exec(location)?.[1]
  if (!version)
    throw new Error(
      `GitHub did not name the latest release (HTTP ${response.status}).`,
    )
  return version
}

/** Whether `latest` is a later release than `current`; unparseable versions compare by inequality. */
export function isNewer(latest: string, current: string): boolean {
  const parts = (version: string) => version.split('.').map(Number)
  const a = parts(latest)
  const b = parts(current)
  if (a.length !== 3 || b.length !== 3 || [...a, ...b].some(Number.isNaN))
    return latest !== current
  for (let index = 0; index < 3; index++)
    if (a[index] !== b[index]) return a[index]! > b[index]!
  return false
}

function realHome(home: string): string {
  try {
    return realpathSync(home)
  } catch {
    return resolve(home)
  }
}

/** Whether this code is a release installed in `home`, rather than a source checkout. */
export function isInstalledRelease(home: string): boolean {
  const code = realpathSync(fileURLToPath(new URL('.', import.meta.url)))
  return code.startsWith(join(realHome(home), 'versions') + sep)
}

/** The version `home/current` points at, or null when nothing is installed. */
export function installedVersion(home: string): string | null {
  try {
    return basename(realpathSync(join(home, 'current')))
  } catch {
    return null
  }
}

export interface FailedUpdate {
  readonly version: string
  readonly message: string
  readonly at: string
}

const failedFile = (home: string) => join(home, 'update-failed.json')

export async function readFailedUpdate(
  home: string,
): Promise<FailedUpdate | null> {
  try {
    return JSON.parse(await readFile(failedFile(home), 'utf8')) as FailedUpdate
  } catch {
    return null
  }
}

export async function recordFailedUpdate(
  home: string,
  version: string,
  message: string,
): Promise<void> {
  const failed: FailedUpdate = {
    version,
    message,
    at: new Date().toISOString(),
  }
  await writeFile(failedFile(home), `${JSON.stringify(failed)}\n`, {
    mode: 0o600,
  })
}

export async function clearFailedUpdate(home: string): Promise<void> {
  await rm(failedFile(home), { force: true })
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok)
    throw new Error(`Could not download ${url} (HTTP ${response.status}).`)
  return Buffer.from(await response.arrayBuffer())
}

/**
 * Runs the release's install.sh after checking it against the release's
 * SHA256SUMS. The installer stops the factory, installs the release and,
 * with `start`, starts it again.
 */
export async function installRelease(
  home: string,
  version: string,
  options: { readonly start: boolean; readonly releases?: string },
): Promise<void> {
  const base = `${options.releases ?? RELEASES}/download/v${version}`
  const [sums, script] = await Promise.all([
    download(`${base}/SHA256SUMS`),
    download(`${base}/install.sh`),
  ])
  const expected = sums
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([, file]) => file === 'install.sh')?.[0]
  if (!expected)
    throw new Error(`The v${version} checksums have no entry for install.sh.`)
  if (createHash('sha256').update(script).digest('hex') !== expected)
    throw new Error(
      `install.sh does not match the v${version} checksum; nothing was installed.`,
    )
  const work = await mkdtemp(join(tmpdir(), 'kf-update-'))
  try {
    const installer = join(work, 'install.sh')
    await writeFile(installer, script, { mode: 0o700 })
    const args = [
      installer,
      '--home',
      resolve(home),
      '--version',
      `v${version}`,
      '--no-modify-path',
      ...(options.start ? [] : ['--no-start']),
    ]
    const code = await new Promise<number>((done, fail) => {
      const child = spawn('/bin/sh', args, { stdio: 'inherit' })
      child.once('error', fail)
      child.once('exit', (exit) => done(exit ?? 1))
    })
    if (code !== 0)
      throw new Error(`The v${version} installer exited with code ${code}.`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
