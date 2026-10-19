import type { UpdateResponse } from './api/contract.ts'
import { factoryVersion, readConfig } from './config.ts'
import {
  isFactoryHealthy,
  isServiceLoaded,
  startService,
  updateLog,
} from './service.ts'
import { displayPath } from './setup.ts'
import {
  clearFailedUpdate,
  installedVersion,
  installRelease,
  isNewer,
  latestRelease,
  readFailedUpdate,
  recordFailedUpdate,
} from './updates.ts'

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
const steps = (count: number) =>
  `${count} running ${count === 1 ? 'step' : 'steps'}`
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/** One line for kf status about newer releases. */
export async function updateLine(
  home: string,
  port: number,
  healthy: boolean,
): Promise<string> {
  if (healthy) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/update`, {
        signal: AbortSignal.timeout(2_000),
      })
      if (response.ok) {
        const status = (await response.json()) as UpdateResponse
        if (status.state === 'available')
          return `v${status.latest} available; run kf update${status.automatic ? ' (or wait: it installs at night)' : ''}`
        if (status.state === 'waiting')
          return `v${status.latest} waiting for ${steps(status.running)} to finish`
        if (status.state === 'installing') return `installing v${status.latest}`
        if (status.state === 'failed')
          return `v${status.latest} failed: ${status.error}; see ${displayPath(updateLog(home))}`
        if (status.latest) return 'up to date'
      }
    } catch {
      // An older factory or a slow response: ask GitHub directly.
    }
  }
  try {
    const latest = await latestRelease(AbortSignal.timeout(5_000))
    const current = installedVersion(home) ?? factoryVersion()
    return isNewer(latest, current)
      ? `v${latest} available; run kf update`
      : 'up to date'
  } catch (error) {
    return `could not check (${message(error)})`
  }
}

/**
 * Updates to the latest release. A running factory installs it itself once
 * its running steps finish; with `now`, or when the factory is stopped, the
 * release installs at once.
 */
export async function updateFactory(
  home: string,
  now: boolean,
): Promise<number> {
  const config = await readConfig(home)
  const loaded = isServiceLoaded(home)
  if (!now && loaded && (await isFactoryHealthy(config.port))) {
    const queued = await queue(home, config.port)
    if (queued !== undefined) return queued
  }
  const current = installedVersion(home) ?? factoryVersion()
  const version = await latestRelease()
  if (!now && !isNewer(version, current)) {
    console.log(`Already up to date (v${current}).`)
    return 0
  }
  try {
    await installRelease(home, version, { start: loaded })
    await clearFailedUpdate(home)
    return 0
  } catch (error) {
    await recordFailedUpdate(home, version, message(error))
    console.error(message(error))
    if (loaded && !isServiceLoaded(home)) {
      await startService(home)
      console.error(`Started v${factoryVersion()} again.`)
    }
    return 1
  }
}

async function queue(home: string, port: number): Promise<number | undefined> {
  const api = `http://127.0.0.1:${port}/api/update`
  const response = await fetch(api, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(30_000),
  })
  // A factory from before self-update installs the old way.
  if (response.status === 404) return undefined
  const body = (await response.json()) as UpdateResponse & { error?: string }
  if (!response.ok) {
    console.error(body.error)
    return 1
  }
  let status: UpdateResponse = body
  if (status.state === 'none') {
    console.log(`Already up to date (v${status.current}).`)
    return 0
  }
  const target = status.latest!
  console.log(
    `Updating to v${target}. Ctrl-C stops watching; the update continues.`,
  )
  const shown = new Set<string>()
  let downSince: number | undefined
  const show = (line: string) => {
    if (!shown.has(line)) console.log(line)
    shown.add(line)
  }
  for (;;) {
    if (status.state === 'failed') {
      console.error(
        `The update failed: ${status.error}\nSee ${displayPath(updateLog(home))}.`,
      )
      return 1
    }
    if (status.state === 'available') {
      console.log('The update was cancelled.')
      return 1
    }
    if (status.state === 'waiting')
      show(
        `Waiting for ${steps(status.running)} to finish. New steps wait until the update is done.`,
      )
    if (status.state === 'installing') show(`Installing v${target}…`)
    await sleep(2_000)
    const failed = await readFailedUpdate(home)
    if (failed?.version === target) {
      console.error(
        `The update failed: ${failed.message}\nSee ${displayPath(updateLog(home))}.`,
      )
      return 1
    }
    if (installedVersion(home) === target && (await isFactoryHealthy(port))) {
      console.log(`Updated to v${target}. Running at http://localhost:${port}`)
      return 0
    }
    try {
      const next = await fetch(api, { signal: AbortSignal.timeout(2_000) })
      if (next.ok) status = (await next.json()) as UpdateResponse
      downSince = undefined
    } catch {
      downSince ??= Date.now()
      show('The factory is restarting…')
      if (Date.now() - downSince > 10 * 60_000) {
        console.error(
          `The factory has not come back after 10 minutes. See kf logs and ${displayPath(updateLog(home))}.`,
        )
        return 1
      }
    }
  }
}
