import { evaluateMergeGate } from '../domain/merge-gate.ts'
import { scenarioIndex } from '../domain/evidence.ts'
import { getMergeGate } from '../store/merge-gates.ts'
import { setArtifactHome } from '../store/database.ts'
import { listDecisions, decisionCounts } from '../store/decisions.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { type Context, Hono } from 'hono'
import { cors } from 'hono/cors'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { DEFAULT_ALLOWED_ORIGINS } from '../config.ts'
import { FactoryError } from '../domain/errors.ts'
import { runsOf } from '../domain/lifecycle.ts'
import { describeRoutes } from '../domain/routing.ts'
import { type Step, stepContract, type Workflow } from '../domain/workflow.ts'
import type { Library } from '../library/library.ts'
import type { Database } from '../store/database.ts'
import type { EventSignal } from '../store/events.ts'
import {
  createRepository,
  listRepositories,
  setAutoMerge,
} from '../store/repositories.ts'
import {
  cancelTicket,
  createTicket,
  decide,
  decideOption,
  getArtifact,
  getTicketDetail,
  listTickets,
  resolveAsk,
} from '../store/tickets.ts'
import { openArtifactFile, inspectArtifactFile } from './artifact-files.ts'
import type {
  ErrorResponse,
  DecisionsResponse,
  HealthResponse,
  RepositoriesResponse,
  RepositoryResponse,
  StepSummary,
  TicketResponse,
  TicketsResponse,
  WorkflowsResponse,
} from './contract.ts'
import { streamEvents } from './event-stream.ts'
import {
  cancelRequest,
  createRepositoryRequest,
  createTicketRequest,
  decisionRequest,
  optionRequest,
  resolveRequest,
  statusFilter,
} from './requests.ts'

export interface AppOptions {
  readonly database: Database
  readonly library: Library
  /** Wakes event streams when events are recorded. */
  readonly events: EventSignal
  /** Factory home; artifact files are served only from inside it. */
  readonly home: string
  /** Browser origins allowed to call the API from elsewhere. */
  readonly allowedOrigins?: readonly string[]
  /** Built web app to serve; omitted in development, where Vite serves it. */
  readonly webRoot?: string
}

class InvalidRequest extends FactoryError {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super('invalid', 'Invalid request')
    this.issues = issues
  }
}

const STATUS: Readonly<Record<FactoryError['code'], ContentfulStatusCode>> = {
  invalid: 400,
  'not-found': 404,
  conflict: 409,
}

export function createApp({
  database,
  library,
  events,
  home,
  allowedOrigins = DEFAULT_ALLOWED_ORIGINS,
  webRoot,
}: AppOptions) {
  setArtifactHome(database, home)
  const app = new Hono()

  app.onError((error, c) => {
    if (error instanceof FactoryError) {
      return c.json<ErrorResponse>(
        {
          error: error.message,
          ...(error instanceof InvalidRequest ? { issues: error.issues } : {}),
        },
        STATUS[error.code],
      )
    }
    console.error(error)
    return c.json<ErrorResponse>({ error: 'Internal error' }, 500)
  })

  app.use(
    '/api/*',
    cors({
      origin: [...allowedOrigins],
      allowMethods: ['GET', 'POST'],
      allowHeaders: ['Content-Type', 'Last-Event-ID'],
      maxAge: 600,
    }),
  )

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

  app.get('/api/repositories', async (c) =>
    c.json<RepositoriesResponse>({
      repositories: await listRepositories(database),
    }),
  )

  app.post('/api/repositories', async (c) => {
    const input = await body(c, createRepositoryRequest)
    const repository = await createRepository(database, {
      slug: input.slug,
      ...(input.cloneUrl === undefined ? {} : { cloneUrl: input.cloneUrl }),
      ...(input.defaultBranch === undefined
        ? {}
        : { defaultBranch: input.defaultBranch }),
    })
    return c.json<RepositoryResponse>({ repository }, 201)
  })

  app.post('/api/repositories/:id{[0-9]+}/auto-merge', async (c) => {
    const input = await body(c, z.strictObject({ enabled: z.boolean() }))
    return c.json<RepositoryResponse>({
      repository: await setAutoMerge(
        database,
        Number(c.req.param('id')),
        input.enabled,
      ),
    })
  })
  app.get('/api/decisions', async (c) =>
    c.json<DecisionsResponse>({
      decisions: await listDecisions(database),
      steps: await decisionCounts(database),
    }),
  )
  app.post('/api/tickets/:number{[0-9]+}/option', async (c) => {
    const number = ticketNumber(c)
    const input = await body(c, optionRequest)
    await decideOption(database, { ticketNumber: number, ...input })
    return c.json<TicketResponse>(await ticketResponse(number))
  })

  app.get('/api/tickets', async (c) => {
    const status = c.req.query('status')
    return c.json<TicketsResponse>({
      tickets: await listTickets(
        database,
        status === undefined ? {} : { status: parse(statusFilter, status) },
      ),
    })
  })

  app.post('/api/tickets', async (c) => {
    const input = await body(c, createTicketRequest)
    const entry = library.get(input.workflow)
    if (!entry) {
      throw new FactoryError(
        'invalid',
        `No workflow "${input.workflow}"; choose one of ${[...library.keys()].join(', ')}`,
      )
    }
    const ticket = await createTicket(database, {
      repository: input.repository,
      ...(input.dependencies === undefined
        ? {}
        : { dependencies: input.dependencies }),
      workflow: entry,
      title: input.title,
      ...(input.body === undefined ? {} : { body: input.body }),
    })
    return c.json<TicketResponse>(await ticketResponse(ticket.number), 201)
  })

  app.get('/api/tickets/:number{[0-9]+}', async (c) =>
    c.json<TicketResponse>(await ticketResponse(ticketNumber(c))),
  )

  app.post('/api/tickets/:number{[0-9]+}/decision', async (c) => {
    const number = ticketNumber(c)
    const input = await body(c, decisionRequest)
    await decide(database, {
      ticketNumber: number,
      attemptId: input.attemptId,
      choice: input.choice,
      ...(input.comment === undefined ? {} : { comment: input.comment }),
    })
    return c.json<TicketResponse>(await ticketResponse(number))
  })

  app.post('/api/tickets/:number{[0-9]+}/resolve', async (c) => {
    const number = ticketNumber(c)
    const input = await body(c, resolveRequest)
    await resolveAsk(database, {
      ticketNumber: number,
      attemptId: input.attemptId,
      resolution:
        input.action === 'move'
          ? { action: 'move', stepId: input.stepId }
          : { action: input.action },
      ...(input.note === undefined ? {} : { note: input.note }),
    })
    return c.json<TicketResponse>(await ticketResponse(number))
  })

  app.post('/api/tickets/:number{[0-9]+}/cancel', async (c) => {
    const number = ticketNumber(c)
    const input = await body(c, cancelRequest, {})
    await cancelTicket(database, {
      ticketNumber: number,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    })
    return c.json<TicketResponse>(await ticketResponse(number))
  })

  app.get('/api/artifacts/:id{[0-9]+}', async (c) => {
    const artifact = await getArtifact(database, Number(c.req.param('id')))
    if (!artifact) throw new FactoryError('not-found', 'No such artifact')
    if (artifact.prunedAt)
      return c.json<ErrorResponse>(
        { error: `Artifact removed after ${artifact.retentionDays} days` },
        410,
      )
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Content-Security-Policy', "default-src 'none'; sandbox")
    if (artifact.content !== null) {
      return c.body(artifact.content, 200, {
        'Content-Type': 'text/markdown; charset=utf-8',
      })
    }
    const file = await openArtifactFile(
      home,
      artifact.path as string,
      c.req.method === 'GET' && !c.req.header('If-Range')
        ? c.req.header('Range')
        : undefined,
    )
    if (!file.ok) {
      return file.reason === 'outside-home'
        ? c.json<ErrorResponse>(
            {
              error: `Artifact ${artifact.id} points outside the factory home, so it is not served`,
            },
            403,
          )
        : c.json<ErrorResponse>(
            { error: `Artifact ${artifact.id}'s file is missing` },
            404,
          )
    }
    return c.body(file.body ?? '', file.status, {
      'Content-Type': file.type,
      'Content-Length': String(file.size),
      'Accept-Ranges': 'bytes',
      ...(file.contentRange ? { 'Content-Range': file.contentRange } : {}),
    })
  })

  app.get('/api/events', (c) => {
    const after = c.req.header('Last-Event-ID') ?? c.req.query('after')
    return streamEvents(
      c,
      database,
      events,
      after === undefined ? undefined : parse(eventId, after),
    )
  })

  app.all('/api/*', (c) => c.json<ErrorResponse>({ error: 'Not found' }, 404))

  // Keep ticket links already published in PR descriptions usable.
  app.get('/tickets/:number{[0-9]+}', (c) =>
    c.redirect(`/#/tickets/${c.req.param('number')}`),
  )

  if (webRoot && existsSync(join(webRoot, 'index.html'))) {
    app.use('/*', serveStatic({ root: webRoot }))
    app.get('/*', serveStatic({ root: webRoot, path: 'index.html' }))
  }

  async function ticketResponse(number: number): Promise<TicketResponse> {
    const detail = await getTicketDetail(database, number)
    if (!detail) throw new FactoryError('not-found', `No ticket #${number}`)
    const { workflow, attempts } = detail
    const snapshot = await getMergeGate(database, detail.ticket.id)
    const observedAttempt = attempts.findLast((a) => a.headCommit)
    const observed = attempts.findLast((a) => a.headCommit)?.headCommit ?? null
    const mergeGate = snapshot
      ? {
          ...snapshot,
          latest: evaluateMergeGate(
            {
              ...snapshot.latest.facts,
              buildWork: attempts.some((a) =>
                ['pending', 'running'].includes(a.status),
              ),
              localHead:
                observedAttempt &&
                Date.parse(
                  observedAttempt.finishedAt ??
                    observedAttempt.startedAt ??
                    observedAttempt.createdAt,
                ) > Date.parse(snapshot.latest.evaluatedAt)
                  ? observed!
                  : snapshot.latest.facts.localHead,
            },
            snapshot.latest.evaluatedAt,
          ),
        }
      : null
    return {
      dependencies: detail.dependencies,
      links: detail.links,
      mergeGate,
      evidenceIndex: scenarioIndex(
        detail.artifacts,
        attempts,
        new Map(
          workflow.steps
            .filter((s) => s.kind === 'agent')
            .map((s) => [s.id, s.role]),
        ),
        mergeGate?.latest.facts.localHead ?? observed,
      ),
      ticket: detail.ticket,
      workflow: {
        name: workflow.name,
        version: detail.ticket.workflow.version,
        description: workflow.description,
        steps: workflow.steps.map((step) => ({
          ...summarize(workflow, step),
          runs: runsOf(attempts, step.id),
        })),
      },
      attempts,
      decisions: await listDecisions(database, detail.ticket.id),
      artifacts: await Promise.all(
        detail.artifacts.map(async (artifact) => {
          if (!artifact.path || artifact.prunedAt) return artifact
          const file = await inspectArtifactFile(home, artifact.path)
          return file.ok ? { ...artifact, mediaType: file.type } : artifact
        }),
      ),
      events: detail.events,
    }
  }

  return app
}

const eventId = z.coerce.number().int().nonnegative()

function ticketNumber(c: Context): number {
  return Number(c.req.param('number'))
}

async function body<T>(
  c: Context,
  schema: z.ZodType<T>,
  empty?: unknown,
): Promise<T> {
  const text = await c.req.text()
  let value: unknown = empty
  if (text.trim() !== '' || empty === undefined) {
    try {
      value = JSON.parse(text)
    } catch {
      throw new FactoryError('invalid', 'The request body must be JSON')
    }
  }
  return parse(schema, value)
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new InvalidRequest(
      parsed.error.issues.map((issue) =>
        issue.path.length === 0
          ? issue.message
          : `${issue.path.join('.')}: ${issue.message}`,
      ),
    )
  }
  return parsed.data
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
