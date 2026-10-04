import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { describeRoutes } from '../domain/routing.ts'
import { type Step, stepContract, type Workflow } from '../domain/workflow.ts'
import type { Library } from '../library/library.ts'
import type { Database } from '../store/database.ts'
import type {
  HealthResponse,
  StepSummary,
  WorkflowsResponse,
} from './contract.ts'

export interface AppOptions {
  readonly database: Database
  readonly library: Library
  /** Built web app to serve; omitted in development, where Vite serves it. */
  readonly webRoot?: string
}

export function createApp({ database, library, webRoot }: AppOptions) {
  const app = new Hono()

  app.get('/api/health', async (c) => {
    await database.query('SELECT 1')
    return c.json<HealthResponse>({ status: 'ok', database: 'ok' })
  })

  app.get('/api/workflows', (c) =>
    c.json<WorkflowsResponse>({
      workflows: [...library.values()].map(({ workflow, version }) => ({
        name: workflow.name,
        version,
        description: workflow.description,
        steps: workflow.steps.map((step) => summarize(workflow, step)),
      })),
    }),
  )

  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404))

  if (webRoot && existsSync(join(webRoot, 'index.html'))) {
    app.use('/*', serveStatic({ root: webRoot }))
    app.get('/*', serveStatic({ root: webRoot, path: 'index.html' }))
  }

  return app
}

function summarize(workflow: Workflow, step: Step): StepSummary {
  const does =
    step.kind === 'agent'
      ? step.role
      : step.kind === 'system'
        ? step.action
        : undefined
  const { success } = stepContract(step)
  return {
    id: step.id,
    kind: step.kind,
    ...(does === undefined ? {} : { does }),
    ...(success === null ? {} : { success }),
    ...(step.instructions === undefined
      ? {}
      : { instructions: step.instructions }),
    ...(step.limit === undefined ? {} : { limit: step.limit }),
    needs: step.kind === 'human' ? [] : step.needs,
    routes: describeRoutes(workflow, step),
  }
}
