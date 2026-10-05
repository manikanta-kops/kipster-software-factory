import { retainArtifact } from '../artifacts/storage.ts'
import { artifactHome } from './database.ts'
import { isAbsolute } from 'node:path'
import { detectMediaType } from '../artifacts/media-type.ts'
// Tickets and their attempts and artifacts. Every write locks the ticket row, asks the
// pure lifecycle what happens, applies the answer and records events in one transaction.
import { FactoryError } from '../domain/errors.ts'
import {
  afterCancel,
  afterDecision,
  afterFailure,
  afterInterruption,
  afterPullRequestBaseAdvance,
  afterResolution,
  afterResult,
  type ArtifactInput,
  branchName,
  checkCapabilities,
  parseStepResult,
  type Resolution,
  startAttempt,
  startTicket,
  stepOf,
  type Opening,
  ticketStatus,
  type Transition,
  waitForMerge,
} from '../domain/lifecycle.ts'
import type {
  Artifact,
  ArtifactKind,
  Attempt,
  AttemptStatus,
  FactoryEvent,
  HumanChoice,
  Repository,
  Ticket,
  TicketAskReason,
  TicketStatus,
  WaitingFor,
} from '../domain/records.ts'
import type { Next } from '../domain/routing.ts'
import type { Step, Workflow } from '../domain/workflow.ts'
import type { LibraryEntry } from '../library/library.ts'
import {
  type Connection,
  type Database,
  type Queryable,
  transaction,
} from './database.ts'
import { listEvents, type NewEvent, recordEvents } from './events.ts'
import { getRepository, getRepositoryById } from './repositories.ts'

export interface NewTicket {
  /** The target repository's `owner/name`. */
  readonly repository: string
  /** The workflow version the ticket will keep for its whole life. */
  readonly workflow: Pick<LibraryEntry, 'workflow' | 'version' | 'source'>
  readonly title: string
  /** Markdown. */
  readonly body?: string
}

export interface TicketDetail {
  readonly ticket: Ticket
  /** The workflow version the ticket runs, which may be older than the library's. */
  readonly workflow: Workflow
  readonly attempts: readonly Attempt[]
  readonly artifacts: readonly Artifact[]
  readonly events: readonly FactoryEvent[]
}

/** Everything the engine needs to run or watch one attempt. */
export interface AttemptContext {
  readonly attempt: Attempt
  readonly ticket: Ticket
  readonly repository: Repository
  readonly workflow: Workflow
  readonly step: Step
}

/** The result of a lifecycle write: the ticket afterwards and the attempt it opened, if any. */
export interface Moved {
  readonly ticket: Ticket
  readonly closed: Attempt
  readonly opened: Attempt | null
}

export interface Interrupted {
  /** Claimed attempts that never started and are claimable again. */
  readonly released: readonly number[]
  readonly interrupted: readonly {
    readonly ticketNumber: number
    readonly attemptId: number
    readonly then: 'retry' | 'ask'
  }[]
}

// Reads

export async function getTicket(
  database: Queryable,
  number: number,
): Promise<Ticket | null> {
  const { rows } = await database.query<TicketRow>(
    `${TICKET_SELECT} WHERE t.number = $1`,
    [number],
  )
  return rows[0] ? toTicket(rows[0]) : null
}

/** Tickets, most recently changed first; only those in the given statuses when set. */
export async function listTickets(
  database: Queryable,
  filter: {
    readonly status?: readonly TicketStatus[]
    readonly cleanupPending?: boolean
  } = {},
): Promise<Ticket[]> {
  const { rows } = await database.query<TicketRow>(
    `${TICKET_SELECT}
     WHERE ($1::text[] IS NULL OR t.status = ANY ($1))
       AND (NOT $2::boolean OR t.worktree_cleaned_at IS NULL)
     ORDER BY t.updated_at DESC, t.id DESC`,
    [filter.status ?? null, filter.cleanupPending ?? false],
  )
  return rows.map(toTicket)
}

export async function getTicketDetail(
  database: Queryable,
  number: number,
): Promise<TicketDetail | null> {
  const ticket = await getTicket(database, number)
  if (!ticket) return null
  const [workflow, attempts, artifacts, events] = await Promise.all([
    loadWorkflow(database, ticket.workflow.name, ticket.workflow.version),
    listAttempts(database, ticket.id),
    listArtifacts(database, ticket.id),
    listEvents(database, { ticketId: ticket.id, limit: 10_000 }),
  ])
  return { ticket, workflow, attempts, artifacts, events }
}

export async function listAttempts(
  database: Queryable,
  ticketId: number,
): Promise<Attempt[]> {
  const { rows } = await database.query<AttemptRow>(
    'SELECT * FROM attempts WHERE ticket_id = $1 ORDER BY id',
    [ticketId],
  )
  return rows.map(toAttempt)
}

export async function listArtifacts(
  database: Queryable,
  ticketId: number,
): Promise<Artifact[]> {
  const { rows } = await database.query<ArtifactRow>(
    `${ARTIFACT_SELECT} WHERE a.ticket_id = $1 ORDER BY a.id`,
    [ticketId],
  )
  return rows.map(toArtifact)
}

export async function getArtifact(
  database: Queryable,
  id: number,
): Promise<Artifact | null> {
  const { rows } = await database.query<ArtifactRow>(
    `${ARTIFACT_SELECT} WHERE a.id = $1`,
    [id],
  )
  return rows[0] ? toArtifact(rows[0]) : null
}

/** Parked GitHub waits for the engine to watch. */
export async function listWaitingForMerge(
  database: Queryable,
  waitingFor:
    'pull-request-merge' | 'pull-request-checks' = 'pull-request-merge',
): Promise<AttemptContext[]> {
  const { rows } = await database.query<AttemptRow>(
    `SELECT * FROM attempts
     WHERE status = 'waiting' AND waiting_for = $1
     ORDER BY id`,
    [waitingFor],
  )
  return Promise.all(rows.map((row) => loadContext(database, toAttempt(row))))
}

// Writes

/**
 * Creates a ticket and opens its first step. The repository must be ready and
 * provide every capability the workflow's steps need.
 */
export async function createTicket(
  database: Database,
  input: NewTicket,
): Promise<Ticket> {
  const { workflow, version, source } = input.workflow
  const title = input.title.trim()
  if (title === '') throw new FactoryError('invalid', 'Give the ticket a title')

  return transaction(database, async (connection) => {
    const repository = await getRepository(connection, input.repository)
    if (!repository) {
      throw new FactoryError(
        'invalid',
        `No repository ${input.repository} is registered`,
      )
    }
    if (repository.status !== 'ready') {
      throw new FactoryError(
        'conflict',
        `${repository.slug} is ${repository.status}${repository.lastError ? ` (${repository.lastError})` : ''}; tickets can start once it is ready`,
      )
    }
    checkCapabilities(workflow, repository)

    await connection.query(
      `INSERT INTO workflow_versions (name, version, source, definition)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (name, version) DO NOTHING`,
      [workflow.name, version, source, JSON.stringify(workflow)],
    )
    const { rows } = await connection.query<{ number: number }>(
      "SELECT nextval('ticket_numbers')::integer AS number",
    )
    const number = (rows[0] as { number: number }).number
    const opening = startTicket(workflow)
    const status = ticketStatus({ status: opening.status, next: null })
    const inserted = await connection.query<{ id: number }>(
      `INSERT INTO tickets (number, repository_id, workflow_name, workflow_version,
                            title, body, branch, current_step, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        number,
        repository.id,
        workflow.name,
        version,
        title,
        input.body ?? '',
        branchName(number, title),
        opening.stepId,
        status,
      ],
    )
    const ticketId = (inserted.rows[0] as { id: number }).id
    const events: NewEvent[] = [
      {
        ticketId,
        kind: 'ticket.created',
        data: {
          number,
          repository: repository.slug,
          workflow: workflow.name,
          version,
          status,
        },
      },
    ]
    await insertOpening(connection, ticketId, opening, events)
    await recordEvents(connection, events)
    return (await getTicket(connection, number)) as Ticket
  })
}

/**
 * Claims up to `limit` pending attempts, oldest first, so no other scheduler takes
 * them. A ticket has at most one open attempt, so no two claimed attempts share a ticket.
 */
export async function claimAttempts(
  database: Database,
  limit: number,
): Promise<AttemptContext[]> {
  const claimed = await transaction(database, async (connection) => {
    const { rows } = await connection.query<AttemptRow>(
      `UPDATE attempts SET claimed_at = now()
       WHERE id IN (
         SELECT id FROM attempts
         WHERE status = 'pending' AND claimed_at IS NULL
         ORDER BY id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [limit],
    )
    const attempts = rows.map(toAttempt).sort((a, b) => a.id - b.id)
    await recordEvents(
      connection,
      attempts.map((attempt) => ({
        ticketId: attempt.ticketId,
        kind: 'attempt.claimed',
        data: { attemptId: attempt.id, stepId: attempt.stepId },
      })),
    )
    return attempts
  })
  return Promise.all(claimed.map((attempt) => loadContext(database, attempt)))
}

/** A claimed attempt's executor has started. */
export async function markRunning(
  database: Database,
  attemptId: number,
  executor: string,
): Promise<Attempt> {
  return transaction(database, async (connection) => {
    const locked = await lockByAttempt(connection, attemptId)
    const attempt = openAttemptOf(locked, attemptId)
    if (attempt.status === 'pending' && attempt.claimedAt === null) {
      throw new FactoryError(
        'conflict',
        `Attempt ${attemptId} has not been claimed`,
      )
    }
    const status = startAttempt(locked.attempts)
    const { rows } = await connection.query<AttemptRow>(
      `UPDATE attempts SET status = 'running', executor = $2, started_at = now()
       WHERE id = $1 RETURNING *`,
      [attemptId, executor],
    )
    const events: NewEvent[] = [
      {
        ticketId: locked.id,
        kind: 'attempt.started',
        data: { attemptId, stepId: attempt.stepId, executor },
      },
    ]
    await setTicketStatus(connection, locked, status, attempt.stepId, events)
    await recordEvents(connection, events)
    return toAttempt(rows[0] as AttemptRow)
  })
}

/**
 * A running agent or system attempt (or one waiting for its pull request to merge)
 * finished. Stores its artifacts and moves the ticket on.
 */
export async function completeAttempt(
  database: Database,
  attemptId: number,
  result: unknown,
  completion: {
    readonly headCommit?: string
    readonly reproductionAttemptId?: number
  } = {},
): Promise<Moved> {
  const parsed = parseStepResult(result)
  if (
    completion.headCommit !== undefined &&
    !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(completion.headCommit)
  )
    throw new Error('Invalid commit object ID')
  return transaction(database, async (connection) => {
    const locked = await lockByAttempt(connection, attemptId)
    openAttemptOf(locked, attemptId)
    const transition = afterResult(locked.workflow, locked.attempts, parsed)
    const events: NewEvent[] = []
    await insertArtifacts(
      connection,
      locked.id,
      attemptId,
      parsed.artifacts,
      events,
    )
    return apply(
      connection,
      locked,
      transition,
      { summary: parsed.summary, ...completion },
      events,
    )
  })
}

/** Park a system attempt for GitHub; completion uses the usual outcome routing. */
export async function waitForPullRequestMerge(
  database: Database,
  attemptId: number,
  waitingFor:
    'pull-request-merge' | 'pull-request-checks' = 'pull-request-merge',
  headCommit: string | null = null,
): Promise<Attempt> {
  return transaction(database, async (connection) => {
    const locked = await lockByAttempt(connection, attemptId)
    const attempt = openAttemptOf(locked, attemptId)
    const status = waitForMerge(locked.workflow, locked.attempts, waitingFor)
    const { rows } = await connection.query<AttemptRow>(
      `UPDATE attempts
       SET status = 'waiting', waiting_for = $2, waiting_since = now(), head_commit = COALESCE($3, head_commit)
       WHERE id = $1 RETURNING *`,
      [attemptId, waitingFor, headCommit],
    )
    const events: NewEvent[] = [
      {
        ticketId: locked.id,
        kind: 'attempt.waiting',
        data: {
          attemptId,
          stepId: attempt.stepId,
          waitingFor,
        },
      },
    ]
    await setTicketStatus(connection, locked, status, attempt.stepId, events)
    await recordEvents(connection, events)
    return toAttempt(rows[0] as AttemptRow)
  })
}

/** A running attempt could not finish; the ticket asks you what to do. */
export async function failAttempt(
  database: Database,
  attemptId: number,
  error: string,
): Promise<Moved> {
  return transaction(database, async (connection) => {
    const locked = await lockByAttempt(connection, attemptId)
    openAttemptOf(locked, attemptId)
    const transition = afterFailure(locked.attempts, error)
    return apply(connection, locked, transition, { error }, [])
  })
}

export async function requeuePullRequestMaintenance(
  database: Database,
  attemptId: number,
  summary: string,
): Promise<Moved> {
  return transaction(database, async (connection) => {
    const locked = await lockByAttempt(connection, attemptId)
    openAttemptOf(locked, attemptId)
    const transition = afterPullRequestBaseAdvance(
      locked.workflow,
      locked.attempts,
    )
    return apply(connection, locked, transition, { summary }, [])
  })
}

/**
 * Interrupts every running attempt and releases claimed attempts that never started.
 * Call it at startup, before the scheduler claims anything.
 */
export async function interruptRunning(
  database: Database,
): Promise<Interrupted> {
  return transaction(database, async (connection) => {
    const released = await connection.query<AttemptRow>(
      `UPDATE attempts SET claimed_at = NULL
       WHERE status = 'pending' AND claimed_at IS NOT NULL
       RETURNING *`,
    )
    const events: NewEvent[] = released.rows.map((row) => ({
      ticketId: row.ticket_id,
      kind: 'attempt.released',
      data: { attemptId: row.id, stepId: row.step_id },
    }))
    await recordEvents(connection, events)

    const running = await connection.query<{ ticket_id: number }>(
      `SELECT DISTINCT ticket_id FROM attempts
       WHERE status = 'running' ORDER BY ticket_id`,
    )
    const interrupted: Interrupted['interrupted'][number][] = []
    for (const { ticket_id } of running.rows) {
      const locked = await lockTicket(connection, { id: ticket_id })
      const attempt = locked.attempts.at(-1) as Attempt
      const transition = afterInterruption(locked.attempts)
      await apply(connection, locked, transition, {}, [])
      interrupted.push({
        ticketNumber: locked.number,
        attemptId: attempt.id,
        then: transition.open?.status === 'pending' ? 'retry' : 'ask',
      })
    }
    return {
      released: released.rows.map((row) => row.id).sort((a, b) => a - b),
      interrupted,
    }
  })
}

/** You decided on a human step. A comment is stored as an artifact for later steps. */
export async function decide(
  database: Database,
  input: {
    readonly ticketNumber: number
    readonly attemptId: number
    readonly choice: HumanChoice
    readonly comment?: string
  },
): Promise<Moved> {
  return transaction(database, async (connection) => {
    const locked = await lockTicket(connection, { number: input.ticketNumber })
    const attempt = openAttemptOf(locked, input.attemptId)
    const comment = input.comment?.trim() ?? ''
    const transition = afterDecision(locked.workflow, locked.attempts, {
      choice: input.choice,
      comment,
    })
    const events: NewEvent[] = [
      {
        ticketId: locked.id,
        kind: 'decision.made',
        data: {
          attemptId: attempt.id,
          stepId: attempt.stepId,
          choice: input.choice,
        },
      },
    ]
    if (comment !== '') {
      await insertArtifacts(
        connection,
        locked.id,
        attempt.id,
        [
          {
            kind: 'comment',
            title: `${input.choice} on ${attempt.stepId}`,
            content: comment,
          },
        ],
        events,
      )
    }
    return apply(
      connection,
      locked,
      transition,
      { summary: comment === '' ? null : comment, executor: 'human' },
      events,
    )
  })
}

/** You answered an ask. A note is stored as an artifact for later steps. */
export async function resolveAsk(
  database: Database,
  input: {
    readonly ticketNumber: number
    readonly attemptId: number
    readonly resolution: Resolution
    readonly note?: string
  },
): Promise<Moved> {
  return transaction(database, async (connection) => {
    const locked = await lockTicket(connection, { number: input.ticketNumber })
    const attempt = openAttemptOf(locked, input.attemptId)
    const transition = afterResolution(
      locked.workflow,
      locked.attempts,
      input.resolution,
    )
    const note = input.note?.trim() ?? ''
    const events: NewEvent[] = [
      {
        ticketId: locked.id,
        kind: 'ask.resolved',
        data: {
          attemptId: attempt.id,
          stepId: attempt.stepId,
          ...input.resolution,
        },
      },
    ]
    if (note !== '') {
      const target =
        transition.close.next?.to === 'step'
          ? `Note for ${transition.close.next.stepId}`
          : 'Why it was cancelled'
      await insertArtifacts(
        connection,
        locked.id,
        attempt.id,
        [{ kind: 'note', title: target, content: note }],
        events,
      )
    }
    return apply(connection, locked, transition, { executor: 'human' }, events)
  })
}

/** Cancels the ticket; whatever attempt is open stops. */
export async function cancelTicket(
  database: Database,
  input: { readonly ticketNumber: number; readonly reason?: string },
): Promise<Moved> {
  return transaction(database, async (connection) => {
    const locked = await lockTicket(connection, { number: input.ticketNumber })
    const transition = afterCancel(locked.attempts)
    const attempt = locked.attempts.at(-1) as Attempt
    const reason = input.reason?.trim() ?? ''
    const events: NewEvent[] = []
    if (reason !== '') {
      await insertArtifacts(
        connection,
        locked.id,
        attempt.id,
        [{ kind: 'note', title: 'Why it was cancelled', content: reason }],
        events,
      )
    }
    return apply(connection, locked, transition, {}, events)
  })
}

export async function setPullRequestUrl(
  database: Database,
  ticketId: number,
  url: string,
): Promise<Ticket> {
  return transaction(database, async (connection) => {
    const { rows } = await connection.query<{ number: number }>(
      `UPDATE tickets SET pull_request_url = $2, updated_at = now()
       WHERE id = $1 RETURNING number`,
      [ticketId, url],
    )
    const row = rows[0]
    if (!row) {
      throw new FactoryError('not-found', `No ticket with id ${ticketId}`)
    }
    await recordEvents(connection, [
      { ticketId, kind: 'ticket.pull-request', data: { url } },
    ])
    return (await getTicket(connection, row.number)) as Ticket
  })
}

/** Keeps evidence available even when an executor fails or the ticket is cancelled. */
export async function addAttemptArtifacts(
  database: Database,
  attemptId: number,
  artifacts: readonly ArtifactInput[],
  observation: { readonly commit?: string } = {},
): Promise<void> {
  const parsed = parseStepResult({
    outcome: 'evidence',
    summary: 'Executor evidence',
    artifacts,
  })
  await transaction(database, async (connection) => {
    const locked = await lockByAttempt(connection, attemptId)
    const events: NewEvent[] = []
    await insertArtifacts(
      connection,
      locked.id,
      attemptId,
      parsed.artifacts,
      events,
      observation.commit,
    )
    await recordEvents(connection, events)
  })
}

// Lifecycle plumbing

interface Locked {
  readonly id: number
  readonly number: number
  readonly status: TicketStatus
  readonly workflow: Workflow
  readonly attempts: readonly Attempt[]
}

// NO KEY UPDATE, not UPDATE: inserting events and artifacts takes KEY SHARE locks on
// the ticket through their foreign keys, and must not wait on (or deadlock with) us.
async function lockTicket(
  connection: Connection,
  by: { readonly id: number } | { readonly number: number },
): Promise<Locked> {
  const byId = 'id' in by
  const { rows } = await connection.query<{
    id: number
    number: number
    status: TicketStatus
    definition: Workflow
  }>(
    `SELECT t.id, t.number, t.status, v.definition
     FROM tickets t
     JOIN workflow_versions v
       ON v.name = t.workflow_name AND v.version = t.workflow_version
     WHERE ${byId ? 't.id' : 't.number'} = $1
     FOR NO KEY UPDATE OF t`,
    [byId ? by.id : by.number],
  )
  const row = rows[0]
  if (!row) {
    throw new FactoryError(
      'not-found',
      byId ? `No ticket with id ${by.id}` : `No ticket #${by.number}`,
    )
  }
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    workflow: row.definition,
    attempts: await listAttempts(connection, row.id),
  }
}

async function lockByAttempt(
  connection: Connection,
  attemptId: number,
): Promise<Locked> {
  const { rows } = await connection.query<{ ticket_id: number }>(
    'SELECT ticket_id FROM attempts WHERE id = $1',
    [attemptId],
  )
  const row = rows[0]
  if (!row) {
    throw new FactoryError('not-found', `No attempt with id ${attemptId}`)
  }
  return lockTicket(connection, { id: row.ticket_id })
}

/** The ticket's open attempt, which must be the one the caller expects. */
function openAttemptOf(locked: Locked, attemptId: number): Attempt {
  const latest = locked.attempts.at(-1)
  const attempt = locked.attempts.find(
    (candidate) => candidate.id === attemptId,
  )
  if (!attempt) {
    throw new FactoryError(
      'not-found',
      `Ticket #${locked.number} has no attempt ${attemptId}`,
    )
  }
  if (attempt !== latest || !isOpen(attempt.status)) {
    throw new FactoryError(
      'conflict',
      `Attempt ${attemptId} of ticket #${locked.number} is ${attempt.status} and no longer open; the ticket has moved on`,
    )
  }
  return attempt
}

async function apply(
  connection: Connection,
  locked: Locked,
  transition: Transition,
  closing: {
    readonly summary?: string | null
    readonly error?: string
    readonly executor?: string
    readonly headCommit?: string
    readonly reproductionAttemptId?: number
  },
  events: NewEvent[],
): Promise<Moved> {
  const current = locked.attempts.at(-1) as Attempt
  const { close, open } = transition
  const { rows } = await connection.query<AttemptRow>(
    `UPDATE attempts
     SET status = $2, outcome = $3, next = $4, summary = coalesce($5, summary),
         error = $6, executor = coalesce($7, executor), finished_at = now(),
         head_commit = coalesce($8, head_commit), reproduction_attempt_id = coalesce($9, reproduction_attempt_id)
     WHERE id = $1
     RETURNING *`,
    [
      current.id,
      close.status,
      close.outcome,
      close.next === null ? null : JSON.stringify(close.next),
      closing.summary ?? null,
      closing.error ?? null,
      closing.executor ?? null,
      closing.headCommit ?? null,
      closing.reproductionAttemptId ?? null,
    ],
  )
  const closed = toAttempt(rows[0] as AttemptRow)
  events.push({
    ticketId: locked.id,
    kind: `attempt.${close.status}`,
    data: {
      attemptId: closed.id,
      stepId: closed.stepId,
      outcome: close.outcome,
      next: close.next,
      ...(closing.error === undefined ? {} : { error: closing.error }),
    },
  })
  const opened =
    open === null
      ? null
      : await insertOpening(connection, locked.id, open, events)
  await setTicketStatus(
    connection,
    locked,
    transition.status,
    (opened ?? closed).stepId,
    events,
  )
  await recordEvents(connection, events)
  return {
    ticket: (await getTicket(connection, locked.number)) as Ticket,
    closed,
    opened,
  }
}

async function insertOpening(
  connection: Connection,
  ticketId: number,
  open: Opening,
  events: NewEvent[],
): Promise<Attempt> {
  const { rows } = await connection.query<AttemptRow>(
    `INSERT INTO attempts (ticket_id, step_id, status, waiting_for, ask_reason, summary,
                           started_at, waiting_since)
     VALUES ($1, $2, $3::text, $4, $5, $6,
             CASE WHEN $3::text = 'waiting' THEN now() END,
             CASE WHEN $3::text = 'waiting' THEN now() END)
     RETURNING *`,
    [
      ticketId,
      open.stepId,
      open.status,
      open.waitingFor,
      open.askReason,
      open.summary,
    ],
  )
  const attempt = toAttempt(rows[0] as AttemptRow)
  events.push(
    open.status === 'pending'
      ? {
          ticketId,
          kind: 'attempt.queued',
          data: { attemptId: attempt.id, stepId: attempt.stepId },
        }
      : {
          ticketId,
          kind: 'attempt.waiting',
          data: {
            attemptId: attempt.id,
            stepId: attempt.stepId,
            waitingFor: open.waitingFor,
            askReason: open.askReason,
          },
        },
  )
  return attempt
}

async function setTicketStatus(
  connection: Connection,
  locked: Locked,
  status: TicketStatus,
  currentStep: string,
  events: NewEvent[],
): Promise<void> {
  await connection.query(
    `UPDATE tickets SET status = $2, current_step = $3, updated_at = now()
     WHERE id = $1`,
    [locked.id, status, currentStep],
  )
  if (status !== locked.status) {
    events.push({
      ticketId: locked.id,
      kind: 'ticket.status',
      data: { from: locked.status, to: status },
    })
  }
}

async function insertArtifacts(
  connection: Connection,
  ticketId: number,
  attemptId: number,
  artifacts: readonly ArtifactInput[],
  events: NewEvent[],
  observedCommit?: string,
): Promise<void> {
  for (const input of artifacts) {
    const home = artifactHome(connection)
    const artifact = home ? await retainArtifact(home, ticketId, input) : input
    let mediaType =
      artifact.content !== undefined
        ? 'text/markdown'
        : 'application/octet-stream'
    if (artifact.path && isAbsolute(artifact.path)) {
      try {
        mediaType = await detectMediaType(artifact.path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const { rows } = await connection.query<{ id: number }>(
      `INSERT INTO artifacts (ticket_id, attempt_id, kind, title, content, path, media_type, scenario, scenario_result, observed_commit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        ticketId,
        attemptId,
        artifact.kind,
        artifact.title,
        artifact.content ?? null,
        artifact.path ?? null,
        mediaType,
        artifact.scenario ?? null,
        artifact.scenarioResult ?? null,
        observedCommit ?? null,
      ],
    )
    events.push({
      ticketId,
      kind: 'artifact.added',
      data: {
        artifactId: (rows[0] as { id: number }).id,
        attemptId,
        kind: artifact.kind,
        title: artifact.title,
      },
    })
  }
}

async function loadWorkflow(
  database: Queryable,
  name: string,
  version: string,
): Promise<Workflow> {
  const { rows } = await database.query<{ definition: Workflow }>(
    'SELECT definition FROM workflow_versions WHERE name = $1 AND version = $2',
    [name, version],
  )
  const row = rows[0]
  if (!row) throw new Error(`Workflow ${name}@${version} is not recorded`)
  return row.definition
}

async function loadContext(
  database: Queryable,
  attempt: Attempt,
): Promise<AttemptContext> {
  const { rows } = await database.query<TicketRow>(
    `${TICKET_SELECT} WHERE t.id = $1`,
    [attempt.ticketId],
  )
  const ticket = toTicket(rows[0] as TicketRow)
  const repository = (await getRepositoryById(
    database,
    ticket.repository.id,
  )) as Repository
  const workflow = await loadWorkflow(
    database,
    ticket.workflow.name,
    ticket.workflow.version,
  )
  return {
    attempt,
    ticket,
    repository,
    workflow,
    step: stepOf(workflow, attempt.stepId),
  }
}

function isOpen(status: AttemptStatus): boolean {
  return status === 'pending' || status === 'running' || status === 'waiting'
}

// Rows

const TICKET_SELECT = `
  SELECT t.*, r.slug AS repository_slug,
         w.id AS waiting_attempt_id, w.step_id AS waiting_step_id,
         w.waiting_for, w.ask_reason AS waiting_ask_reason,
         w.summary AS waiting_summary, w.waiting_since
  FROM tickets t
  JOIN repositories r ON r.id = t.repository_id
  LEFT JOIN attempts w ON w.ticket_id = t.id AND w.status = 'waiting'`

interface TicketRow {
  id: number
  number: number
  repository_id: number
  repository_slug: string
  workflow_name: string
  workflow_version: string
  title: string
  body: string
  branch: string
  pull_request_url: string | null
  current_step: string
  status: TicketStatus
  created_at: Date
  updated_at: Date
  waiting_attempt_id: number | null
  waiting_step_id: string | null
  waiting_for: WaitingFor | null
  waiting_ask_reason: TicketAskReason | null
  waiting_summary: string | null
  waiting_since: Date | null
}

function toTicket(row: TicketRow): Ticket {
  return {
    id: row.id,
    number: row.number,
    repository: { id: row.repository_id, slug: row.repository_slug },
    workflow: { name: row.workflow_name, version: row.workflow_version },
    title: row.title,
    body: row.body,
    branch: row.branch,
    pullRequestUrl: row.pull_request_url,
    currentStep: row.current_step,
    status: row.status,
    waiting:
      row.waiting_attempt_id === null
        ? null
        : {
            attemptId: row.waiting_attempt_id,
            stepId: row.waiting_step_id as string,
            for: row.waiting_for as WaitingFor,
            askReason: row.waiting_ask_reason,
            summary: row.waiting_summary,
            since: (row.waiting_since as Date).toISOString(),
          },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

interface AttemptRow {
  id: number
  ticket_id: number
  step_id: string
  status: AttemptStatus
  outcome: string | null
  summary: string | null
  executor: string | null
  error: string | null
  waiting_for: WaitingFor | null
  ask_reason: TicketAskReason | null
  next: Next | null
  created_at: Date
  claimed_at: Date | null
  started_at: Date | null
  waiting_since: Date | null
  head_commit: string | null
  reproduction_attempt_id: number | null
  finished_at: Date | null
}

function toAttempt(row: AttemptRow): Attempt {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    stepId: row.step_id,
    status: row.status,
    outcome: row.outcome,
    summary: row.summary,
    executor: row.executor,
    error: row.error,
    waitingFor: row.waiting_for,
    askReason: row.ask_reason,
    next: row.next,
    createdAt: row.created_at.toISOString(),
    claimedAt: iso(row.claimed_at),
    startedAt: iso(row.started_at),
    waitingSince: iso(row.waiting_since),
    headCommit: row.head_commit,
    reproductionAttemptId: row.reproduction_attempt_id,
    finishedAt: iso(row.finished_at),
  }
}

const ARTIFACT_SELECT = `
  SELECT a.*, at.step_id FROM artifacts a JOIN attempts at ON at.id = a.attempt_id`

interface ArtifactRow {
  observed_commit: string | null
  scenario_result: Exclude<Artifact['scenarioResult'], undefined>
  scenario: string | null
  pruned_at: Date | null
  retention_days: number | null
  media_type: string
  id: number
  ticket_id: number
  attempt_id: number
  step_id: string
  kind: ArtifactKind
  title: string
  content: string | null
  path: string | null
  created_at: Date
}

function toArtifact(row: ArtifactRow): Artifact {
  return {
    mediaType: row.media_type,
    observedCommit: row.observed_commit,
    scenario: row.scenario,
    scenarioResult: row.scenario_result,
    prunedAt: iso(row.pruned_at),
    retentionDays: row.retention_days,
    id: row.id,
    ticketId: row.ticket_id,
    attemptId: row.attempt_id,
    stepId: row.step_id,
    kind: row.kind,
    title: row.title,
    content: row.content,
    path: row.path,
    createdAt: row.created_at.toISOString(),
  }
}

function iso(date: Date | null): string | null {
  return date === null ? null : date.toISOString()
}

export async function markWorktreeCleaned(
  database: Queryable,
  ticketId: number,
) {
  await database.query(
    "UPDATE tickets SET worktree_cleaned_at = now() WHERE id = $1 AND status IN ('done', 'cancelled')",
    [ticketId],
  )
}

/** A factory observation after execution, including failures/cancellation with a readable checkout. */
export async function recordAttemptHeadCommit(
  database: Queryable,
  attemptId: number,
  headCommit: string,
): Promise<void> {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(headCommit))
    throw new Error('Invalid commit object ID')
  await database.query(
    'UPDATE attempts SET head_commit = $2 WHERE id = $1 AND head_commit IS NULL',
    [attemptId, headCommit],
  )
}
