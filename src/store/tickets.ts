import { proposeLessons } from '../domain/lessons.ts'
import {
  afterParallelResults,
  parallelReviewer,
} from '../domain/parallel-final.ts'
import { insertLessonProposals, listLessons } from './lessons.ts'
import { summarizeTicket, type TicketSummary } from '../domain/summary.ts'
import { getMergeGate } from './gate-records.ts'
import {
  withPreparedArtifacts,
  type PreparedArtifact,
} from './artifact-preparation.ts'
import type { SkippedStep } from '../domain/task-testing.ts'
import { listTicketLinks, listDependencies } from './ticket-links.ts'
import { getTaskOfChild, listTasks, taskEvent } from './task-records.ts'
import { type AgentChoice, runTasksParams } from '../domain/catalog.ts'
import {
  delegateTarget,
  isFinalTask,
  replacements,
  taskWorkflowName,
} from '../domain/tasks.ts'
import type { DecisionInput } from '../domain/decisions.ts'
import { insertDecision, finishDecision } from './decisions.ts'
// Tickets and their attempts and artifacts. Every write locks the ticket row, asks the
// pure lifecycle what happens, applies the answer and records events in one transaction.
import { FactoryError, AttemptMovedOn } from '../domain/errors.ts'
import {
  afterLinkedTicket,
  waitForOtherRepository,
  afterCancel,
  autoApprovePlan,
  afterDecision,
  type StepResult,
  afterTypedDecision,
  waitForDecision,
  afterFailure,
  afterInterruption,
  afterPullRequestBaseAdvance,
  afterPullRequestMergedWhileWaiting,
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
  OWNER_WAITS,
  ticketStatus,
  type Transition,
  waitForMerge,
} from '../domain/lifecycle.ts'
import { defaultLightsOut } from '../domain/records.ts'
import type {
  Artifact,
  ArtifactKind,
  Attempt,
  AttemptStatus,
  FactoryEvent,
  HumanChoice,
  LeadTask,
  ParentTask,
  Repository,
  Ticket,
  TicketLink,
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
  readonly lightsOut?: boolean
  /** The target repository's `owner/name`. */
  readonly repository: string
  /** The workflow version the ticket will keep for its whole life. */
  readonly workflow: Pick<LibraryEntry, 'workflow' | 'version' | 'source'>
  readonly title: string
  /** Markdown. */
  readonly body?: string
  readonly dependencies?: readonly string[]
}

export interface TicketDetail {
  readonly ticket: Ticket
  readonly dependencies: readonly Repository[]
  readonly links: readonly TicketLink[]
  /** A lead ticket's tasks, oldest first. */
  readonly tasks: readonly LeadTask[]
  /** On a child ticket, the lead ticket and task it runs. */
  readonly parentTask: ParentTask | null
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
  const [
    workflow,
    attempts,
    artifacts,
    events,
    dependencies,
    links,
    tasks,
    parent,
  ] = await Promise.all([
    loadWorkflow(database, ticket.workflow.name, ticket.workflow.version),
    listAttempts(database, ticket.id),
    listArtifacts(database, ticket.id),
    listEvents(database, { ticketId: ticket.id, limit: 10_000 }),
    listDependencies(database, ticket.id),
    listTicketLinks(database, ticket.id),
    listTasks(database, ticket.id),
    getTaskOfChild(database, ticket.id),
  ])
  return {
    ticket,
    workflow,
    attempts,
    artifacts,
    events,
    dependencies,
    links,
    tasks,
    parentTask: parent
      ? {
          ...parent.parent,
          replacedBy: isFinalTask(parent.task.status)
            ? (replacements(
                await listTasks(database, parent.task.ticketId),
              ).get(parent.task.key) ?? null)
            : null,
        }
      : null,
  }
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

/** Owner waits on tickets with a pull request, which the owner may merge on GitHub meanwhile. */
export async function listOwnerWaitsWithPullRequest(
  database: Queryable,
): Promise<AttemptContext[]> {
  const { rows } = await database.query<AttemptRow>(
    `SELECT a.* FROM attempts a JOIN tickets t ON t.id = a.ticket_id
     WHERE a.status = 'waiting' AND a.waiting_for = ANY($1)
       AND t.pull_request_url IS NOT NULL
     ORDER BY a.id`,
    [OWNER_WAITS],
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
  return transaction(database, (connection) =>
    createTicketInTransaction(connection, input),
  )
}

export async function createTicketInTransaction(
  connection: Connection,
  input: NewTicket,
  requireCapabilities = true,
): Promise<Ticket> {
  const { workflow, version, source } = input.workflow
  const title = input.title.trim()
  if (title === '') throw new FactoryError('invalid', 'Give the ticket a title')

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
  if (requireCapabilities) checkCapabilities(workflow, repository)
  const dependencies: Repository[] = []
  for (const slug of input.dependencies ?? []) {
    const dependency = await getRepository(connection, slug)
    if (!dependency)
      throw new FactoryError(
        'invalid',
        `No dependency repository ${slug} is registered`,
      )
    if (dependency.id === repository.id)
      throw new FactoryError(
        'invalid',
        'A ticket cannot depend on its own repository',
      )
    if (!dependencies.some((item) => item.id === dependency.id))
      dependencies.push(dependency)
  }

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
                            title, body, branch, current_step, status, lights_out)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
      input.lightsOut ?? defaultLightsOut(workflow.name),
    ],
  )
  const ticketId = (inserted.rows[0] as { id: number }).id
  for (const dependency of dependencies)
    await connection.query(
      'INSERT INTO ticket_dependencies (ticket_id, repository_id) VALUES ($1, $2)',
      [ticketId, dependency.id],
    )
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
  await refreshTicketSummary(connection, number, events)
  await recordEvents(connection, events)
  return (await getTicket(connection, number)) as Ticket
}

/**
 * Claims up to `limit` pending attempts, oldest first, so no other scheduler takes
 * them. Paired reviewers start with their tester; only the lifecycle cursor is claimable.
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
  agent: AgentChoice | null = null,
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
    const step = stepOf(locked.workflow, attempt.stepId)
    if (step.kind === 'agent' && ['builder', 'tester'].includes(step.role))
      await connection.query('DELETE FROM base_syncs WHERE ticket_id = $1', [
        locked.id,
      ])
    const { rows } = await connection.query<AttemptRow>(
      `UPDATE attempts SET status = 'running', executor = $2, agent = $3, started_at = now()
       WHERE id = $1 RETURNING *`,
      [attemptId, executor, agent && JSON.stringify(agent)],
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
  return withPreparedArtifacts(
    database,
    attemptId,
    parsed.artifacts,
    (artifacts) =>
      transaction(database, async (connection) => {
        const locked = await lockByAttempt(connection, attemptId)
        const attempt = openAttemptOf(locked, attemptId)
        const transition = afterResult(locked.workflow, locked.attempts, parsed)
        const events: NewEvent[] = []
        await insertTasks(
          connection,
          locked,
          attemptId,
          attempt.stepId,
          parsed,
          events,
        )
        await insertArtifacts(
          connection,
          locked.id,
          attemptId,
          artifacts,
          events,
        )
        if (parsed.outcome === 'merged')
          await connection.query(
            'DELETE FROM base_syncs WHERE ticket_id = $1',
            [locked.id],
          )
        return apply(
          connection,
          locked,
          transition,
          {
            summary: parsed.summary,
            ...completion,
            ...(parsed.ownerReview ? { ownerReview: parsed.ownerReview } : {}),
          },
          events,
        )
      }),
  )
}

export async function startParallelReview(
  database: Database,
  testerId: number,
  agent: AgentChoice,
  headCommit: string,
): Promise<Attempt> {
  return transaction(database, async (connection) => {
    const locked = await lockByAttempt(connection, testerId)
    const tester = openAttemptOf(locked, testerId)
    const reviewer = parallelReviewer(
      locked.workflow,
      stepOf(locked.workflow, tester.stepId),
    )
    if (tester.status !== 'running' || !reviewer)
      throw new FactoryError('conflict', 'No running final test to pair')
    await connection.query(
      'UPDATE attempts SET head_commit = $2 WHERE id = $1',
      [testerId, headCommit],
    )
    const { rows } = await connection.query<AttemptRow>(
      `INSERT INTO attempts (ticket_id, step_id, status, parallel_parent_id, executor, agent, head_commit, started_at)
       VALUES ($1, $2, 'running', $3, $4, $5, $6, now()) RETURNING *`,
      [
        locked.id,
        reviewer.id,
        testerId,
        agent.cli,
        JSON.stringify(agent),
        headCommit,
      ],
    )
    const attempt = toAttempt(rows[0]!)
    await recordEvents(connection, [
      {
        ticketId: locked.id,
        kind: 'attempt.started',
        data: {
          attemptId: attempt.id,
          stepId: attempt.stepId,
          executor: agent.cli,
          agent,
        },
      },
    ])
    return attempt
  })
}

export type ParallelCompletion = {
  completion: { headCommit: string; reproductionAttemptId?: number }
} & ({ result: StepResult } | { error: string })

export async function completeParallelAttempts(
  database: Database,
  testerId: number,
  reviewerId: number,
  tested: ParallelCompletion,
  reviewed: ParallelCompletion,
): Promise<Moved> {
  const testerResult =
    'result' in tested ? parseStepResult(tested.result) : null
  const reviewerResult =
    'result' in reviewed ? parseStepResult(reviewed.result) : null
  const error =
    'error' in tested
      ? tested.error
      : 'error' in reviewed
        ? reviewed.error
        : undefined
  if (tested.completion.headCommit !== reviewed.completion.headCommit)
    throw new Error('Parallel verdicts disagree on the commit')
  return withPreparedArtifacts(
    database,
    testerId,
    testerResult?.artifacts ?? [],
    (testerArtifacts) =>
      withPreparedArtifacts(
        database,
        reviewerId,
        reviewerResult?.artifacts ?? [],
        (reviewerArtifacts) =>
          transaction(database, async (connection) => {
            const locked = await lockByAttempt(connection, testerId)
            openAttemptOf(locked, testerId)
            const { rows } = await connection.query<AttemptRow>(
              "SELECT * FROM attempts WHERE id = $1 AND parallel_parent_id = $2 AND status = 'running'",
              [reviewerId, testerId],
            )
            if (!rows[0])
              throw new AttemptMovedOn('Parallel review is no longer running')
            const reviewer = toAttempt(rows[0])
            if (reviewer.headCommit !== tested.completion.headCommit)
              throw new Error('Parallel verdict is stale')
            const transition = afterParallelResults(
              locked.workflow,
              locked.attempts,
              [...locked.attempts.slice(0, -1), reviewer],
              testerResult,
              reviewerResult,
              error,
            )
            const events: NewEvent[] = []
            await insertArtifacts(
              connection,
              locked.id,
              testerId,
              testerArtifacts,
              events,
            )
            await insertArtifacts(
              connection,
              locked.id,
              reviewerId,
              reviewerArtifacts,
              events,
            )
            await connection.query(
              `UPDATE attempts SET status = $6, outcome = $2, summary = $3, next = $4,
           owner_review = $5, error = $7, finished_at = now() WHERE id = $1`,
              [
                reviewerId,
                reviewerResult?.outcome ?? null,
                reviewerResult?.summary ?? null,
                JSON.stringify(transition.close.next),
                reviewerResult?.ownerReview
                  ? JSON.stringify(reviewerResult.ownerReview)
                  : null,
                reviewerResult ? 'finished' : 'failed',
                'error' in reviewed ? reviewed.error : null,
              ],
            )
            events.push({
              ticketId: locked.id,
              kind: reviewerResult ? 'attempt.finished' : 'attempt.failed',
              data: {
                attemptId: reviewerId,
                stepId: reviewer.stepId,
                outcome: reviewerResult?.outcome ?? null,
                next: transition.close.next,
                ...('error' in reviewed ? { error: reviewed.error } : {}),
              },
            })
            return apply(
              connection,
              locked,
              transition,
              {
                summary: testerResult?.summary ?? null,
                ...tested.completion,
                ...('error' in tested ? { error: tested.error } : {}),
                ...(testerResult?.ownerReview
                  ? { ownerReview: testerResult.ownerReview }
                  : {}),
              },
              events,
            )
          }),
      ),
  )
}

/** Linking and parking commit together; a replay of the same builder result returns the existing link. */
export async function linkOtherRepository(
  database: Database,
  attemptId: number,
  result: unknown,
  workflow: NewTicket['workflow'],
  headCommit: string,
): Promise<TicketLink> {
  const parsed = parseStepResult(result)
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(headCommit))
    throw new FactoryError('invalid', 'Invalid commit object ID')
  if (!parsed.otherRepository)
    throw new FactoryError('invalid', 'Missing other repository request')
  const { rows: recorded } = await database.query<{
    original_ticket_id: number
  }>('SELECT original_ticket_id FROM ticket_links WHERE attempt_id = $1', [
    attemptId,
  ])
  if (recorded[0])
    return (
      await listTicketLinks(database, recorded[0].original_ticket_id)
    ).find((link) => link.attemptId === attemptId)!
  const replay = new Error('Linked ticket already recorded')
  let replayed: TicketLink | undefined
  try {
    return await withPreparedArtifacts(
      database,
      attemptId,
      parsed.artifacts,
      (artifacts) =>
        transaction(database, async (connection) => {
          const locked = await lockByAttempt(connection, attemptId)
          const existing = (await listTicketLinks(connection, locked.id)).find(
            (link) => link.attemptId === attemptId,
          )
          if (existing) {
            replayed = existing
            throw replay
          }
          const attempt = openAttemptOf(locked, attemptId)
          const status = waitForOtherRepository(
            locked.workflow,
            locked.attempts,
          )
          const original = (await getTicket(connection, locked.number))!
          const target = await getRepository(
            connection,
            parsed.otherRepository!.repository,
          )
          if (!target)
            throw new FactoryError(
              'invalid',
              `No repository ${parsed.otherRepository!.repository} is registered`,
            )
          if (target.id === original.repository.id)
            throw new FactoryError(
              'invalid',
              'needs-other-repo must target another repository',
            )
          if (workflow.workflow.name !== parsed.otherRepository!.workflow)
            throw new FactoryError(
              'invalid',
              'Linked workflow does not match the request',
            )
          const linked = await createTicketInTransaction(connection, {
            ...parsed.otherRepository!,
            workflow,
            dependencies: [original.repository.slug],
          })
          await connection.query(
            'INSERT INTO ticket_links (original_ticket_id, attempt_id, linked_ticket_id, request) VALUES ($1, $2, $3, $4)',
            [
              locked.id,
              attemptId,
              linked.id,
              JSON.stringify(parsed.otherRepository),
            ],
          )
          const events: NewEvent[] = []
          await insertArtifacts(
            connection,
            locked.id,
            attemptId,
            artifacts,
            events,
          )
          await connection.query(
            `UPDATE attempts SET status = 'waiting', waiting_for = 'other-repo', waiting_since = now(), outcome = 'needs-other-repo', summary = $2, head_commit = $3 WHERE id = $1`,
            [attemptId, parsed.summary, headCommit],
          )
          events.push(
            {
              ticketId: locked.id,
              kind: 'attempt.waiting',
              data: {
                attemptId,
                stepId: attempt.stepId,
                waitingFor: 'other-repo',
                linkedTicketNumber: linked.number,
              },
            },
            {
              ticketId: linked.id,
              kind: 'ticket.linked',
              data: { originalTicketNumber: locked.number },
            },
          )
          await setTicketStatus(
            connection,
            locked,
            status,
            attempt.stepId,
            events,
          )
          await recordEvents(connection, events)
          return (await listTicketLinks(connection, locked.id)).find(
            (link) => link.attemptId === attemptId,
          )!
        }),
    )
  } catch (error) {
    if (error === replay && replayed) return replayed
    throw error
  }
}

export async function resolveLinkedTicket(
  database: Database,
  link: TicketLink,
  mergeCommit: string | null,
  summary: string,
): Promise<void> {
  if (
    mergeCommit !== null &&
    !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(mergeCommit)
  )
    throw new FactoryError('invalid', 'Invalid merge commit')
  await transaction(database, async (connection) => {
    const locked = await lockByAttempt(connection, link.attemptId)
    const currentLink = (await listTicketLinks(connection, locked.id)).find(
      (item) => item.id === link.id,
    )
    if (!currentLink || currentLink.resolvedAt) return
    if (['done', 'cancelled'].includes(locked.status)) return
    const attempt = openAttemptOf(locked, link.attemptId)
    if (!['done', 'cancelled'].includes(currentLink.linked.status)) return
    const transition = afterLinkedTicket(
      locked.attempts,
      mergeCommit !== null,
      summary,
    )
    await connection.query(
      'UPDATE ticket_links SET merge_commit = $2, resolved_at = now() WHERE id = $1',
      [link.id, mergeCommit],
    )
    const events: NewEvent[] = []
    await insertArtifacts(
      connection,
      locked.id,
      attempt.id,
      [
        {
          kind: 'note',
          title: `Linked ticket #${currentLink.linked.number}`,
          content: summary,
        },
      ],
      events,
    )
    await apply(connection, locked, transition, {}, events)
  })
}

/** Logs the model outcome and applies routing or parks for an owner in one transaction. */
export async function recordDecisionOutcome(
  database: Database,
  attemptId: number,
  input: DecisionInput,
): Promise<void> {
  await transaction(database, async (connection) => {
    const locked = await lockByAttempt(connection, attemptId)
    const attempt = openAttemptOf(locked, attemptId)
    waitForDecision(locked.workflow, locked.attempts)
    await insertDecision(connection, locked.id, attemptId, input)
    const events: NewEvent[] = []
    if (input.band === 'acted') {
      const summary = `Model chose ${input.answer!.choice} (${input.answer!.confidence} confidence)`
      const transition = afterResult(locked.workflow, locked.attempts, {
        outcome: input.answer!.choice,
        summary,
      })
      events.push({
        ticketId: locked.id,
        kind: 'decision.made',
        data: {
          attemptId,
          stepId: attempt.stepId,
          choice: input.answer!.choice,
          decidedBy: 'model',
        },
      })
      await apply(
        connection,
        locked,
        transition,
        { summary, headCommit: input.facts.headCommit },
        events,
      )
    } else {
      await connection.query(
        `UPDATE attempts SET status = 'waiting', waiting_for = 'decision', waiting_since = now(), summary = $2, head_commit = $3 WHERE id = $1`,
        [
          attemptId,
          input.reason ??
            (input.band === 'confirm'
              ? 'Confirm the proposed option or choose another.'
              : 'Choose an option; the model probabilities are information only.'),
          input.facts.headCommit,
        ],
      )
      events.push({
        ticketId: locked.id,
        kind: 'attempt.waiting',
        data: { attemptId, stepId: attempt.stepId, waitingFor: 'decision' },
      })
      await setTicketStatus(
        connection,
        locked,
        'needs-you',
        attempt.stepId,
        events,
      )
      await recordEvents(connection, events)
    }
  })
}
export async function decideOption(
  database: Database,
  input: { ticketNumber: number; attemptId: number; option: string },
): Promise<Moved> {
  return transaction(database, async (connection) => {
    const locked = await lockTicket(connection, { number: input.ticketNumber })
    const attempt = openAttemptOf(locked, input.attemptId)
    const transition = afterTypedDecision(
      locked.workflow,
      locked.attempts,
      input.option,
    )
    await finishDecision(connection, input.attemptId, input.option)
    return apply(
      connection,
      locked,
      transition,
      { summary: `Owner chose ${input.option}`, executor: 'human' },
      [
        {
          ticketId: locked.id,
          kind: 'decision.made',
          data: {
            attemptId: input.attemptId,
            stepId: attempt.stepId,
            choice: input.option,
            decidedBy: 'owner',
          },
        },
      ],
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

/** The owner merged the pull request on GitHub while this attempt waited on them. */
export async function finishMergedWhileWaiting(
  database: Database,
  attemptId: number,
  merge: {
    readonly pullRequestUrl: string
    readonly mergeCommit: string
    readonly mergedBy: 'factory' | 'owner'
  },
): Promise<Moved> {
  return transaction(database, async (connection) => {
    const locked = await lockByAttempt(connection, attemptId)
    openAttemptOf(locked, attemptId)
    const transition = afterPullRequestMergedWhileWaiting(locked.attempts)
    const events: NewEvent[] = []
    await insertArtifacts(
      connection,
      locked.id,
      attemptId,
      [
        {
          kind: 'note',
          title: 'Pull request merged on GitHub while waiting',
          content: `${merge.pullRequestUrl} was merged by ${merge.mergedBy} at merge commit ${merge.mergeCommit} while the ticket waited on you, so the ticket finished.`,
        },
      ],
      events,
    )
    return apply(
      connection,
      locked,
      transition,
      {
        executor: 'system',
        eventSummary: `Pull request merged on GitHub by ${merge.mergedBy} while waiting: ${merge.pullRequestUrl}`,
      },
      events,
    )
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
    if (
      input.resolution.action === 'retry' ||
      input.resolution.action === 'move'
    )
      await connection.query('DELETE FROM base_syncs WHERE ticket_id = $1', [
        locked.id,
      ])
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
    const moved = await apply(connection, locked, transition, {}, events)
    await cancelTasks(connection, locked)
    const summaryEvents: NewEvent[] = []
    await refreshTicketSummary(connection, locked.number, summaryEvents)
    await recordEvents(connection, summaryEvents)
    return {
      ...moved,
      ticket: (await getTicket(connection, locked.number)) as Ticket,
    }
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
  await withPreparedArtifacts(
    database,
    attemptId,
    parsed.artifacts,
    (prepared) =>
      transaction(database, async (connection) => {
        const locked = await lockByAttempt(connection, attemptId)
        const events: NewEvent[] = []
        await insertArtifacts(
          connection,
          locked.id,
          attemptId,
          prepared,
          events,
          observation.commit,
        )
        await recordEvents(connection, events)
      }),
  )
}

/** Records a lead's new tasks and pull request decisions with its completed attempt. */
async function insertTasks(
  connection: Connection,
  locked: Locked,
  attemptId: number,
  stepId: string,
  result: Pick<StepResult, 'tasks' | 'pullRequests'>,
  events: NewEvent[],
): Promise<void> {
  const tasks = result.tasks ?? []
  const decisions = result.pullRequests ?? []
  if (tasks.length === 0 && decisions.length === 0) return
  const target = delegateTarget(locked.workflow, stepId)
  const params = runTasksParams.parse(target?.with ?? {})
  for (const task of tasks) {
    await connection.query(
      `INSERT INTO tasks (ticket_id, attempt_id, key, title, instructions, land, workflow, agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        locked.id,
        attemptId,
        task.key,
        task.title,
        task.instructions,
        task.land,
        taskWorkflowName(task, params),
        task.agent ? JSON.stringify(task.agent) : null,
      ],
    )
    events.push(taskEvent(locked.id, task.key, 'pending'))
  }
  for (const { task, decision } of decisions) {
    const leftOpen = decision === 'leave-open'
    const { rowCount } = await connection.query(
      `UPDATE tasks SET decision = $3, updated_at = now(),
         status = CASE WHEN $4 THEN 'left-open' ELSE status END,
         reported_status = CASE WHEN $4 THEN 'left-open' ELSE reported_status END,
         result = CASE WHEN $4 THEN 'The lead left the pull request open for the owner.' ELSE result END
       WHERE ticket_id = $1 AND key = $2 AND land = 'pr' AND status = 'pr-ready' AND decision IS NULL`,
      [locked.id, task, decision, leftOpen],
    )
    if (rowCount !== 1)
      throw new FactoryError(
        'invalid',
        `Task "${task}" has no undecided ready pull request`,
      )
    events.push(taskEvent(locked.id, task, leftOpen ? 'left-open' : 'pr-ready'))
  }
}

/** Inside cancelTicket: the lead's unfinished tasks stop, and so do their child tickets. */
async function cancelTasks(
  connection: Connection,
  lead: Pick<Locked, 'id' | 'number'>,
): Promise<void> {
  const { rows } = await connection.query<{
    id: number
    key: string
    child_ticket_id: number | null
  }>(
    `SELECT id, key, child_ticket_id FROM tasks
     WHERE ticket_id = $1 AND status IN ('pending', 'running', 'parked', 'pr-ready')
     ORDER BY id FOR UPDATE`,
    [lead.id],
  )
  for (const task of rows) {
    if (task.child_ticket_id !== null) {
      const child = await lockTicket(connection, { id: task.child_ticket_id })
      if (!['done', 'cancelled'].includes(child.status)) {
        const events: NewEvent[] = []
        await insertArtifacts(
          connection,
          child.id,
          (child.attempts.at(-1) as { id: number }).id,
          [
            {
              kind: 'note',
              title: 'Why it was cancelled',
              content: `Lead ticket #${lead.number} was cancelled.`,
            },
          ],
          events,
        )
        await apply(connection, child, afterCancel(child.attempts), {}, events)
      }
    }
    await connection.query(
      `UPDATE tasks SET status = 'cancelled', result = 'The lead ticket was cancelled.', updated_at = now() WHERE id = $1`,
      [task.id],
    )
    await recordEvents(connection, [taskEvent(lead.id, task.key, 'cancelled')])
  }
}

// Lifecycle plumbing

export interface Locked {
  readonly id: number
  readonly number: number
  readonly status: TicketStatus
  readonly workflow: Workflow
  readonly attempts: readonly Attempt[]
}

// NO KEY UPDATE, not UPDATE: inserting events and artifacts takes KEY SHARE locks on
// the ticket through their foreign keys, and must not wait on (or deadlock with) us.
export async function lockTicket(
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
    // The paired reviewer is execution history, not a second lifecycle cursor.
    attempts: (
      await connection.query<AttemptRow>(
        `SELECT * FROM attempts WHERE ticket_id = $1 AND
       (parallel_parent_id IS NULL OR status NOT IN ('pending', 'running', 'waiting'))
       ORDER BY coalesce(parallel_parent_id, id), (parallel_parent_id IS NULL)::integer`,
        [row.id],
      )
    ).rows.map(toAttempt),
  }
}

export async function lockByAttempt(
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
export function openAttemptOf(locked: Locked, attemptId: number): Attempt {
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
    throw new AttemptMovedOn(
      `Attempt ${attemptId} of ticket #${locked.number} is ${attempt.status} and no longer open; the ticket has moved on`,
    )
  }
  return attempt
}

export async function apply(
  connection: Connection,
  locked: Locked,
  transition: Transition,
  closing: {
    readonly summary?: string | null
    readonly error?: string
    readonly executor?: string
    readonly headCommit?: string
    readonly reproductionAttemptId?: number
    readonly ownerReview?: { readonly reason: string }
    /** A readable line for the closing event, where the attempt summary is not one. */
    readonly eventSummary?: string
  },
  events: NewEvent[],
): Promise<Moved> {
  const current = locked.attempts.at(-1) as Attempt
  const { close, open } = transition
  const siblings = await connection.query<AttemptRow>(
    `UPDATE attempts SET status = 'interrupted', next = $2, finished_at = now()
     WHERE parallel_parent_id = $1 AND status = 'running' RETURNING *`,
    [
      current.id,
      close.next?.to === 'cancel' ? JSON.stringify(close.next) : null,
    ],
  )
  for (const sibling of siblings.rows)
    events.push({
      ticketId: locked.id,
      kind: 'attempt.interrupted',
      data: {
        attemptId: sibling.id,
        stepId: sibling.step_id,
        next: close.next,
      },
    })
  const { rows } = await connection.query<AttemptRow>(
    `UPDATE attempts
     SET status = $2, outcome = $3, next = $4, summary = coalesce($5, summary),
         error = $6, executor = coalesce($7, executor), finished_at = now(),
         head_commit = coalesce($8, head_commit), reproduction_attempt_id = coalesce($9, reproduction_attempt_id), owner_review = $10
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
      closing.ownerReview ? JSON.stringify(closing.ownerReview) : null,
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
      ...(closing.ownerReview ? { ownerReview: closing.ownerReview } : {}),
      ...(closing.eventSummary ? { summary: closing.eventSummary } : {}),
      ...(closing.error === undefined ? {} : { error: closing.error }),
    },
  })
  const opened =
    open === null
      ? null
      : await insertOpening(connection, locked.id, open, events)
  if (
    opened &&
    autoApprovePlan(locked.workflow, closed, open) &&
    (await getTicket(connection, locked.number))?.lightsOut
  ) {
    const summary = 'Plan auto-approved under lights-out.'
    events.push({
      ticketId: locked.id,
      kind: 'decision.made',
      data: {
        attemptId: opened.id,
        stepId: opened.stepId,
        choice: 'approved',
        autoApproved: true,
        lightsOut: true,
        summary,
      },
    })
    const history = [...locked.attempts.slice(0, -1), closed, opened]
    const approved = await apply(
      connection,
      { ...locked, attempts: history },
      afterDecision(locked.workflow, history, { choice: 'approved' }),
      { summary, executor: 'system' },
      events,
    )
    return { ...approved, closed }
  }
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

export async function setTicketStatus(
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
  await refreshTicketSummary(connection, locked.number, events)
}

/** Called only inside the lifecycle/gate transaction while holding the ticket lock. */
export async function refreshTicketSummary(
  connection: Connection,
  number: number,
  events: NewEvent[],
): Promise<void> {
  const facts = await summaryFacts(connection, number)
  if (!facts) return
  const { ticket, workflow, attempts, artifacts, tasks } = facts
  const childErrors = await connection.query<{ id: number; error: string }>(
    `SELECT a.id, a.error FROM attempts a JOIN tasks t ON t.child_ticket_id = a.ticket_id
     WHERE t.ticket_id = $1 AND a.status = 'failed' AND a.error IS NOT NULL`,
    [ticket.id],
  )
  await insertLessonProposals(
    connection,
    proposeLessons({
      ticket,
      workflow,
      attempts,
      artifacts,
      existing: [
        ...(await listLessons(connection, {
          repositoryId: ticket.repository.id,
        })),
        ...(await listLessons(connection, { repositoryId: null })),
      ],
      failures: [
        ...attempts
          .filter((a) => a.status === 'failed' && a.error)
          .map((a) => ({ id: a.id, error: a.error! })),
        ...childErrors.rows,
        ...tasks
          .filter(
            (task) =>
              task.status === 'failed' &&
              /^(?:Could not start:|Could not merge into the lead branch:)/.test(
                task.result ?? '',
              ),
          )
          .map((task) => ({ id: `task-${task.id}`, error: task.result! })),
      ].map((a) => ({
        key: String(a.id),
        status: 'failed' as const,
        result: a.error,
      })),
    }),
    events,
  )
  const summary = summarizeTicket(facts)
  await connection.query(
    'UPDATE tickets SET summary = $2, summary_at = now() WHERE id = $1',
    [ticket.id, JSON.stringify(summary)],
  )
  events.push({
    ticketId: ticket.id,
    kind: 'ticket.summary',
    data: { status: summary.status },
  })
}

/** What a summary is computed from, for a ticket in a state that has one. */
async function summaryFacts(connection: Queryable, number: number) {
  const ticket = await getTicket(connection, number)
  if (!ticket || !['done', 'cancelled', 'needs-you'].includes(ticket.status))
    return null
  const gate = await getMergeGate(connection, ticket.id)
  return {
    ticket,
    workflow: await loadWorkflow(
      connection,
      ticket.workflow.name,
      ticket.workflow.version,
    ),
    attempts: await listAttempts(connection, ticket.id),
    artifacts: await listArtifacts(connection, ticket.id),
    tasks: await listTasks(connection, ticket.id),
    mergeGate: gate?.latest ?? null,
  }
}

export async function insertArtifacts(
  connection: Connection,
  ticketId: number,
  attemptId: number,
  artifacts: readonly PreparedArtifact[],
  events: NewEvent[],
  observedCommit?: string,
): Promise<void> {
  for (const artifact of artifacts) {
    const mediaType =
      (artifact.kind === 'decision' ? 'text/markdown' : artifact.mediaType) ??
      (artifact.content !== undefined
        ? 'text/markdown'
        : 'application/octet-stream')
    const { rows } = await connection.query<{ id: number }>(
      `INSERT INTO artifacts (ticket_id, attempt_id, kind, title, content, path, media_type, scenario, scenario_result, observed_commit, decision, file)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [
        ticketId,
        attemptId,
        artifact.kind,
        artifact.title,
        artifact.kind === 'decision'
          ? `Chose: ${artifact.chose}\n\nAlternative: ${artifact.alternative}\n\nReason: ${artifact.reason}`
          : (artifact.content ?? null),
        artifact.path ?? null,
        mediaType,
        artifact.scenario ?? null,
        artifact.scenarioResult ?? null,
        observedCommit ?? null,
        artifact.kind === 'decision'
          ? JSON.stringify({
              chose: artifact.chose,
              alternative: artifact.alternative,
              reason: artifact.reason,
            })
          : null,
        artifact.file ?? null,
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
  summary: TicketSummary | null
  summary_at: Date | null
  skipped_steps: SkippedStep[]
  lights_out: boolean
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
    summary: row.summary,
    summaryAt: iso(row.summary_at),
    skippedSteps: row.skipped_steps,
    lightsOut: row.lights_out,
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
  owner_review: { reason: string } | null
  id: number
  ticket_id: number
  step_id: string
  status: AttemptStatus
  outcome: string | null
  summary: string | null
  executor: string | null
  agent: AgentChoice | null
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
    ownerReview: row.owner_review,
    id: row.id,
    ticketId: row.ticket_id,
    stepId: row.step_id,
    status: row.status,
    outcome: row.outcome,
    summary: row.summary,
    executor: row.executor,
    agent: row.agent,
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
  file: string | null
  decision: Exclude<Artifact['decision'], undefined>
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
    ...(row.file ? { file: row.file } : {}),
    decision: row.decision,
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
