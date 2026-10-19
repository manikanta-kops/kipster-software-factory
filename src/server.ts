import { signInToGitHubWithCli } from './github/credentials.ts'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { createApp } from './api/app.ts'
import {
  engineConfig,
  type EngineConfig,
  defaultHome,
  factoryVersion,
  settingsFromConfig,
} from './config.ts'
import { effectiveSettings, hasSavedSettings } from './store/settings.ts'
import { isServiceLoaded, startUpdateJob } from './service.ts'
import { startUpdater, type Updater } from './updater.ts'
import {
  clearFailedUpdate,
  isInstalledRelease,
  latestRelease,
  readFailedUpdate,
} from './updates.ts'
import {
  addUploads,
  BUILT_IN_WORKFLOWS,
  loadLibrary,
} from './library/library.ts'
import { openDatabase } from './store/database.ts'
import { registerScratchRepository } from './store/repositories.ts'
import { createScratchGit } from './workspace/scratch.ts'
import { listenForEvents } from './store/events.ts'
import { migrate } from './store/migrate.ts'
import { startScheduler } from './engine/scheduler.ts'
import {
  listUploadedWorkflows,
  recordWorkflowVersions,
} from './store/workflows.ts'

export const BUILT_WEB_APP = fileURLToPath(
  new URL('../dist/web/', import.meta.url),
)

export interface FactoryOptions {
  readonly evidenceRetentionDays?: number
  readonly concurrency?: number
  readonly stepTimeoutMinutes?: number
  readonly agents?: EngineConfig['agents']
  /** Serve without executing tickets, for demo data and UI development. */
  readonly scheduler?: boolean
  readonly databaseUrl: string
  readonly port: number
  readonly host?: string
  readonly workflows?: string
  readonly webRoot?: string
  /** Factory home (default: ~/.kipster-factory). */
  readonly home?: string
  readonly allowedOrigins?: readonly string[]
}

export interface RunningFactory {
  readonly url: string
  close(): Promise<void>
}

/** Prepares the database and workflow library, then serves the API and web app. */
export async function startFactory(
  options: FactoryOptions,
): Promise<RunningFactory> {
  signInToGitHubWithCli()
  const loaded = await loadLibrary(options.workflows ?? BUILT_IN_WORKFLOWS)
  if (!loaded.ok) {
    throw new Error(`Invalid workflows:\n  ${loaded.errors.join('\n  ')}`)
  }

  const config = engineConfig.parse(options)
  const database = openDatabase(options.databaseUrl)
  try {
    await migrate(database)
    if (await hasSavedSettings(database))
      console.log(
        'Engine settings come from the factory database; config.json concurrency, stepTimeoutMinutes and agents are ignored.',
      )
    await recordWorkflowVersions(database, loaded.library)
    await registerScratchRepository(
      database,
      await createScratchGit(options.home ?? defaultHome()),
    )
    for (const warning of addUploads(
      loaded.library,
      await listUploadedWorkflows(database),
    ))
      console.warn(warning)
  } catch (error) {
    await database.end()
    throw error
  }

  const events = listenForEvents(database)
  let scheduler: Awaited<ReturnType<typeof startScheduler>> | undefined
  try {
    await events.ready
    if (options.scheduler !== false)
      scheduler = await startScheduler({
        database,
        events,
        library: loaded.library,
        home: options.home ?? defaultHome(),
        config,
        ...(loaded.library.get('bug')
          ? { bugWorkflow: loaded.library.get('bug')! }
          : {}),
      })
  } catch (error) {
    await events.close()
    await database.end()
    throw error
  }
  const home = options.home ?? defaultHome()
  let updates: Updater | undefined
  if (scheduler && isInstalledRelease(home)) {
    let serviceLoaded = { at: 0, value: false }
    updates = startUpdater({
      current: factoryVersion(),
      blocked() {
        if (Date.now() - serviceLoaded.at > 60_000)
          serviceLoaded = { at: Date.now(), value: isServiceLoaded(home) }
        return serviceLoaded.value
          ? null
          : 'This factory is not running as the background service. Run kf update.'
      },
      latest: (signal) => latestRelease(signal),
      scheduler,
      automatic: async () =>
        (await effectiveSettings(database, settingsFromConfig(config))).settings
          .autoUpdate,
      install: () => startUpdateJob(home),
      failed: () => readFailedUpdate(home),
      clearFailed: () => clearFailedUpdate(home),
    })
  }
  const app = createApp({
    database,
    library: loaded.library,
    events,
    home: options.home ?? defaultHome(),
    settings: settingsFromConfig(config),
    ...(options.allowedOrigins === undefined
      ? {}
      : { allowedOrigins: options.allowedOrigins }),
    ...(options.webRoot === undefined ? {} : { webRoot: options.webRoot }),
    ...(updates ? { updates } : {}),
  })
  const host = options.host ?? '127.0.0.1'
  const server = await new Promise<ReturnType<typeof serve>>(
    (resolve, reject) => {
      const listening = serve(
        { fetch: app.fetch, port: options.port, hostname: host },
        () => resolve(listening),
      )
      listening.once('error', reject)
    },
  ).catch(async (error) => {
    updates?.close()
    await scheduler?.close()
    await events.close()
    await database.end()
    throw error
  })

  return {
    url: `http://${host}:${options.port}`,
    async close() {
      updates?.close()
      await scheduler?.close()
      await events.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        // Event streams stay open until their clients leave; don't wait for them.
        if ('closeAllConnections' in server) server.closeAllConnections()
      })
      await database.end()
    },
  }
}
