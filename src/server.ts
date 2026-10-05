import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { createApp } from './api/app.ts'
import { engineConfig, type EngineConfig, defaultHome } from './config.ts'
import { BUILT_IN_WORKFLOWS, loadLibrary } from './library/library.ts'
import { openDatabase } from './store/database.ts'
import { listenForEvents } from './store/events.ts'
import { migrate } from './store/migrate.ts'
import { startScheduler } from './engine/scheduler.ts'
import { recordWorkflowVersions } from './store/workflows.ts'

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
  const loaded = await loadLibrary(options.workflows ?? BUILT_IN_WORKFLOWS)
  if (!loaded.ok) {
    throw new Error(`Invalid workflows:\n  ${loaded.errors.join('\n  ')}`)
  }

  const database = openDatabase(options.databaseUrl)
  try {
    await migrate(database)
    await recordWorkflowVersions(database, loaded.library)
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
        config: engineConfig.parse(options),
        ...(loaded.library.get('bug')
          ? { bugWorkflow: loaded.library.get('bug')! }
          : {}),
      })
  } catch (error) {
    await events.close()
    await database.end()
    throw error
  }
  const app = createApp({
    database,
    library: loaded.library,
    events,
    home: options.home ?? defaultHome(),
    ...(options.allowedOrigins === undefined
      ? {}
      : { allowedOrigins: options.allowedOrigins }),
    ...(options.webRoot === undefined ? {} : { webRoot: options.webRoot }),
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
    await scheduler?.close()
    await events.close()
    await database.end()
    throw error
  })

  return {
    url: `http://${host}:${options.port}`,
    async close() {
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
