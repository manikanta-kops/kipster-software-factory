import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SERVICE_APP_NAME = 'Kipster Software Factory.app'
export const SERVICE_BUNDLE_ID = 'app.kipster.factory'
export const BUNDLED_SERVICE_APP = fileURLToPath(
  new URL(`../native/${SERVICE_APP_NAME}`, import.meta.url),
)

export function verifyServiceApp(app: string): void {
  if (!existsSync(app))
    throw new Error(
      'The macOS service launcher is missing. Install a release, or use kf serve when developing from source.',
    )
  execFileSync(
    '/usr/bin/codesign',
    ['--verify', '--strict', '-R', `=identifier "${SERVICE_BUNDLE_ID}"`, app],
    { stdio: 'pipe', timeout: 10_000 },
  )
  const entitlements = execFileSync(
    '/usr/bin/codesign',
    ['-d', '--entitlements', ':-', app],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 },
  )
  if (
    !/<key>com\.apple\.security\.automation\.apple-events<\/key>\s*<true\s*\/>/.test(
      entitlements,
    )
  )
    throw new Error(
      'The macOS service launcher is missing its automation entitlement. Reinstall the factory.',
    )
  const description = execFileSync(
    '/usr/bin/plutil',
    [
      '-extract',
      'NSAppleEventsUsageDescription',
      'raw',
      '-o',
      '-',
      join(app, 'Contents', 'Info.plist'),
    ],
    { encoding: 'utf8', timeout: 10_000 },
  ).trim()
  if (!description)
    throw new Error(
      'The macOS service launcher has no automation usage description. Reinstall the factory.',
    )
}

export function registerServiceApp(executable: string): void {
  const app = join(executable, '../../..')
  execFileSync(
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
    ['-f', app],
    { stdio: 'pipe', timeout: 30_000 },
  )
}

/** Stage and verify before stopping the service; never rewrite a running signed app. */
export async function prepareServiceApp(options: {
  home: string
  node: string
  cli: string
  stop: () => Promise<unknown>
  source?: string
}): Promise<string> {
  const source = options.source ?? BUNDLED_SERVICE_APP
  verifyServiceApp(source)
  const service = join(options.home, 'service')
  await mkdir(service, { recursive: true, mode: 0o700 })
  const info = await lstat(service)
  if (
    !info.isDirectory() ||
    info.uid !== userInfo().uid ||
    (info.mode & 0o077) !== 0
  )
    throw new Error(
      'The service directory must be a private directory owned by this user.',
    )
  const staging = await mkdtemp(join(service, '.install-'))
  const app = join(service, SERVICE_APP_NAME)
  const candidate = join(staging, SERVICE_APP_NAME)
  const previous = join(staging, 'previous.app')
  let installed = false
  try {
    execFileSync('/usr/bin/ditto', [source, candidate], {
      stdio: 'pipe',
      timeout: 30_000,
    })
    verifyServiceApp(candidate)
    if (existsSync(app)) verifyServiceApp(app)
    const manifest = join(staging, 'runtime.json')
    await writeFile(
      manifest,
      JSON.stringify({ version: 1, node: options.node, cli: options.cli }),
      { mode: 0o600 },
    )
    await options.stop()
    if (existsSync(app)) await rename(app, previous)
    try {
      await rename(candidate, app)
    } catch (error) {
      if (existsSync(previous)) await rename(previous, app)
      throw error
    }
    await rename(manifest, join(service, 'runtime.json'))
    installed = true
    return join(app, 'Contents', 'MacOS', 'Factory')
  } finally {
    if (installed || !existsSync(previous))
      await rm(staging, { recursive: true, force: true })
  }
}
