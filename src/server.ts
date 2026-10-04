import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { createApp } from './api/app.ts'
import { BUILT_IN_WORKFLOWS, loadLibrary } from './library/library.ts'
import { openDatabase } from './store/database.ts'
import { migrate } from './store/migrate.ts'
import { recordWorkflowVersions } from './store/workflows.ts'

export const BUILT_WEB_APP = fileURLToPath(
  new URL('../dist/web/', import.meta.url),
)

export interface FactoryOptions {
  readonly databaseUrl: string
  readonly port: number
  readonly host?: string
  readonly workflows?: string
  readonly webRoot?: string
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

  const app = createApp({
    database,
    library: loaded.library,
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
  )

  return {
    url: `http://${host}:${options.port}`,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      await database.end()
    },
  }
}
