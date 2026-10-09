// Runs the factory in the background as a launchd user agent on macOS.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultHome } from './config.ts'
import {
  prepareServiceApp,
  registerServiceApp,
  SERVICE_BUNDLE_ID,
} from './service-app.ts'

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url))

export function serviceLabel(home: string): string {
  if (resolve(home) === resolve(defaultHome())) return 'app.kipster.factory'
  const key = createHash('sha256').update(resolve(home)).digest('hex')
  return `app.kipster.factory.${key.slice(0, 8)}`
}

export function serviceLog(home: string): string {
  return join(home, 'logs', 'factory.log')
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** Keeps the user's tool directories but drops npm's per-package bin directories. */
export function servicePath(path: string): string {
  return path
    .split(':')
    .filter((entry) => entry && !entry.includes('node_modules/.bin'))
    .join(':')
}

export function launchAgent(options: {
  label: string
  program: readonly string[]
  path: string
  log: string
  workingDirectory: string
  bundleIdentifier?: string
}): string {
  const string = (value: string) => `<string>${escapeXml(value)}</string>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${string(options.label)}
${options.bundleIdentifier ? `  <key>AssociatedBundleIdentifiers</key>\n  <array>${string(options.bundleIdentifier)}</array>\n` : ''}\
  <key>ProgramArguments</key>
  <array>
${options.program.map((part) => `    ${string(part)}`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    ${string(options.path)}
  </dict>
  <key>WorkingDirectory</key>
  ${string(options.workingDirectory)}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  ${string(options.log)}
  <key>StandardErrorPath</key>
  ${string(options.log)}
</dict>
</plist>
`
}

function requireMacOS() {
  if (process.platform !== 'darwin')
    throw new Error(
      'The background service needs macOS; run kf serve in a terminal instead.',
    )
}

function plistPath(label: string): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
}

function launchctl(args: string[]) {
  const result = spawnSync('launchctl', args, {
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (result.error)
    throw new Error(
      'Could not query or control the factory login service. Its state is unknown.',
      { cause: result.error },
    )
  return result
}

function domain(): string {
  return `gui/${userInfo().uid}`
}

function isLoaded(label: string): boolean {
  return launchctl(['print', `${domain()}/${label}`]).status === 0
}

export function isServiceLoaded(home: string): boolean {
  requireMacOS()
  return isLoaded(serviceLabel(home))
}

// The old process must release the port and stop its database before a new one starts.
async function unload(label: string): Promise<boolean> {
  if (!isLoaded(label)) return false
  launchctl(['bootout', `${domain()}/${label}`])
  const deadline = Date.now() + 30_000
  while (isLoaded(label) && Date.now() < deadline)
    await new Promise((done) => setTimeout(done, 250))
  if (isLoaded(label))
    throw new Error(
      'The previous factory service has not stopped. Its files have been preserved; inspect kf logs before restarting.',
    )
  return true
}

/** Writes the launch agent for this installation and (re)starts it. */
export async function startService(home: string): Promise<void> {
  requireMacOS()
  const label = serviceLabel(home)
  const log = serviceLog(home)
  await mkdir(join(home, 'logs'), { recursive: true, mode: 0o700 })
  await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
  const launcher = await prepareServiceApp({
    home: resolve(home),
    node: process.execPath,
    cli: CLI,
    stop: () => unload(label),
  })
  registerServiceApp(launcher)
  const path = plistPath(label)
  await writeFile(
    path,
    launchAgent({
      label,
      program: [launcher, '--home', resolve(home)],
      bundleIdentifier: SERVICE_BUNDLE_ID,
      path: servicePath(process.env['PATH'] ?? '/usr/bin:/bin'),
      log,
      workingDirectory: resolve(home),
    }),
  )
  const result = launchctl(['bootstrap', domain(), path])
  if (result.status !== 0)
    throw new Error(
      `launchctl could not start the factory: ${(result.stderr || result.stdout).trim()}`,
    )
}

/** Stops the service and removes it from login items until the next kf start. */
export async function stopService(home: string): Promise<boolean> {
  requireMacOS()
  const label = serviceLabel(home)
  const loaded = await unload(label)
  await rm(plistPath(label), { force: true })
  return loaded
}

export async function isFactoryHealthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2_000),
    })
    return response.ok
  } catch {
    return false
  }
}

export async function waitForFactory(
  port: number,
  timeoutMs = 90_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isFactoryHealthy(port)) return true
    await new Promise((done) => setTimeout(done, 500))
  }
  return false
}
