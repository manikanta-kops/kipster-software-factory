// The ticket lifecycle: given a ticket's attempts and what just happened, decide how the
// open attempt closes and which attempt opens next. The store applies the answer.
import { z } from 'zod'
import { LIMIT } from './catalog.ts'
import { FactoryError } from './errors.ts'
import {
  ARTIFACT_KINDS,
  type ArtifactKind,
  type AttemptStatus,
  type HumanChoice,
  OPEN_STATUSES,
  type TicketAskReason,
  type TicketStatus,
  type WaitingFor,
} from './records.ts'
import { firstStep, type Next, nextStep } from './routing.ts'
import {
  missingCapabilities,
  routeKeys,
  type Step,
  type Workflow,
} from './workflow.ts'

/** Largest markdown an artifact may store in the database; bigger output belongs in a file. */
export const MAX_ARTIFACT_CONTENT = 1_000_000

export interface ArtifactInput {
  readonly kind: ArtifactKind
  readonly title: string
  /** Markdown. Give exactly one of content and path. */
  readonly content?: string | undefined
  /** A file inside the factory home, absolute or relative to it. */
  readonly path?: string | undefined
}

/** What an agent or system step reports when it finishes (an agent's result.json). */
export interface StepResult {
  readonly outcome: string
  readonly summary: string
  readonly artifacts: readonly ArtifactInput[]
}

export const artifactInputSchema = z
  .strictObject({
    kind: z.enum(ARTIFACT_KINDS),
    title: z.string().trim().min(1).max(200),
    content: z.string().max(MAX_ARTIFACT_CONTENT).optional(),
    path: z.string().min(1).optional(),
  })
  .refine(
    (artifact) =>
      (artifact.content === undefined) !== (artifact.path === undefined),
    { message: 'give either content or path' },
  )

export const stepResultSchema = z.strictObject({
  outcome: z.string().min(1),
  summary: z.string().trim().min(1),
  artifacts: z.array(artifactInputSchema).default([]),
})

/** What the lifecycle needs to know about each of a ticket's attempts, oldest first. */
export interface AttemptState {
  readonly stepId: string
  readonly status: AttemptStatus
  readonly waitingFor: WaitingFor | null
  readonly next: Next | null
}

/** How the open attempt ends. */
export interface Closing {
  readonly status: 'finished' | 'failed' | 'interrupted'
  readonly outcome: string | null
  readonly next: Next | null
}

/** The attempt to open next. */
export interface Opening {
  readonly stepId: string
  readonly status: 'pending' | 'waiting'
  readonly waitingFor: 'human' | 'ask' | null
  readonly askReason: TicketAskReason | null
  /** For asks, why the ticket stopped. */
  readonly summary: string | null
}

export interface Transition {
  readonly close: Closing
  readonly open: Opening | null
  /** The ticket's status afterwards. */
  readonly status: TicketStatus
}

export type Resolution =
  | { readonly action: 'retry' }
  | { readonly action: 'move'; readonly stepId: string }
  | { readonly action: 'cancel' }

export function ticketStatus(
  latest: Pick<AttemptState, 'status' | 'next'>,
): TicketStatus {
  if (latest.next?.to === 'finish') return 'done'
  if (latest.next?.to === 'cancel') return 'cancelled'
  if (latest.status === 'pending') return 'queued'
  if (latest.status === 'running') return 'running'
  return 'needs-you'
}

/** Finished runs of a step. Interrupted attempts and asks are not runs. */
export function runsOf(
  attempts: readonly AttemptState[],
  stepId: string,
): number {
  return attempts.filter(
    (attempt) =>
      attempt.stepId === stepId &&
      attempt.status === 'finished' &&
      attempt.waitingFor !== 'ask',
  ).length
}

/** The attempt that starts a step: human steps wait for you, others wait for the scheduler. */
export function openStep(workflow: Workflow, stepId: string): Opening {
  const step = stepOf(workflow, stepId)
  return step.kind === 'human'
    ? {
        stepId,
        status: 'waiting',
        waitingFor: 'human',
        askReason: null,
        summary: null,
      }
    : {
        stepId,
        status: 'pending',
        waitingFor: null,
        askReason: null,
        summary: null,
      }
}

export function startTicket(workflow: Workflow): Opening {
  return openStep(workflow, firstStep(workflow).id)
}

/** Every outcome an agent or system step may report. */
export function reportableOutcomes(step: Step): readonly string[] {
  return routeKeys(step).filter((key) => key !== LIMIT)
}

export function parseStepResult(value: unknown): StepResult {
  const parsed = stepResultSchema.safeParse(value)
  if (!parsed.success) {
    throw new FactoryError(
      'invalid',
      `Invalid step result: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'result'}: ${issue.message}`)
        .join('; ')}`,
    )
  }
  return parsed.data
}

/** An agent or system step finished with a result. */
export function afterResult(
  workflow: Workflow,
  history: readonly AttemptState[],
  result: Pick<StepResult, 'outcome' | 'summary'>,
): Transition {
  const attempt = openAttempt(history)
  const step = stepOf(workflow, attempt.stepId)
  if (step.kind === 'human') {
    throw new FactoryError(
      'conflict',
      `Step "${step.id}" is a human step; it finishes with a decision`,
    )
  }
  if (!isRunning(attempt)) {
    throw new FactoryError(
      'conflict',
      `Step "${step.id}" is ${attempt.status}, not running`,
    )
  }
  const outcomes = reportableOutcomes(step)
  if (!outcomes.includes(result.outcome)) {
    throw new FactoryError(
      'invalid',
      `Step "${step.id}" cannot report "${result.outcome}"; it can report ${outcomes.join(', ')}`,
    )
  }
  return route(workflow, history, step, result.outcome, result.summary)
}

/** You decided on a human step. */
export function afterDecision(
  workflow: Workflow,
  history: readonly AttemptState[],
  decision: { readonly choice: HumanChoice; readonly comment?: string },
): Transition {
  const attempt = openAttempt(history)
  if (attempt.status !== 'waiting' || attempt.waitingFor !== 'human') {
    throw new FactoryError(
      'conflict',
      `Step "${attempt.stepId}" is not waiting for a decision`,
    )
  }
  const comment = decision.comment?.trim() ?? ''
  if (decision.choice === 'changes-needed' && comment === '') {
    throw new FactoryError(
      'invalid',
      'Say what needs to change: changes-needed requires a comment',
    )
  }
  const step = stepOf(workflow, attempt.stepId)
  return route(workflow, history, step, decision.choice, comment)
}

/** You answered an ask: retry the step, move to another step, or cancel the ticket. */
export function afterResolution(
  workflow: Workflow,
  history: readonly AttemptState[],
  resolution: Resolution,
): Transition {
  const attempt = openAttempt(history)
  if (attempt.status !== 'waiting' || attempt.waitingFor !== 'ask') {
    throw new FactoryError(
      'conflict',
      `Step "${attempt.stepId}" is not waiting on an ask`,
    )
  }
  if (resolution.action === 'cancel') {
    return transition(
      { status: 'finished', outcome: null, next: { to: 'cancel' } },
      null,
    )
  }
  const stepId =
    resolution.action === 'retry' ? attempt.stepId : resolution.stepId
  const open = openStep(workflow, stepId)
  return transition(
    { status: 'finished', outcome: null, next: { to: 'step', stepId } },
    open,
  )
}

/** The step could not finish, for example because its executor crashed. You decide what next. */
export function afterFailure(
  history: readonly AttemptState[],
  error: string,
): Transition {
  const attempt = openAttempt(history)
  if (!isRunning(attempt)) {
    throw new FactoryError(
      'conflict',
      `Step "${attempt.stepId}" is ${attempt.status}, not running`,
    )
  }
  return transition(
    { status: 'failed', outcome: null, next: null },
    ask(attempt.stepId, 'failed', `${attempt.stepId} failed: ${error}`),
  )
}

/**
 * The factory stopped while the step ran. The step is retried once; if the attempt
 * before this one was also an interrupted run of the same step, the ticket asks you.
 */
export function afterInterruption(
  history: readonly AttemptState[],
): Transition {
  const attempt = openAttempt(history)
  if (attempt.status !== 'running') {
    throw new FactoryError(
      'conflict',
      `Step "${attempt.stepId}" is ${attempt.status}, not running`,
    )
  }
  const previous = history.at(-2)
  const again =
    previous?.status === 'interrupted' && previous.stepId === attempt.stepId
  return transition(
    { status: 'interrupted', outcome: null, next: null },
    again
      ? ask(
          attempt.stepId,
          'interrupted',
          `${attempt.stepId} was interrupted twice in a row.`,
        )
      : {
          stepId: attempt.stepId,
          status: 'pending',
          waitingFor: null,
          askReason: null,
          summary: null,
        },
  )
}

/** You cancelled the ticket; whatever is open stops. */
export function afterCancel(history: readonly AttemptState[]): Transition {
  openAttempt(history)
  return transition(
    { status: 'interrupted', outcome: null, next: { to: 'cancel' } },
    null,
  )
}

/** A system step parks its running attempt until the pull request is merged. */
export function waitForMerge(
  workflow: Workflow,
  history: readonly AttemptState[],
): TicketStatus {
  const attempt = openAttempt(history)
  if (stepOf(workflow, attempt.stepId).kind !== 'system') {
    throw new FactoryError(
      'conflict',
      `Only system steps wait for a pull request merge, not "${attempt.stepId}"`,
    )
  }
  if (attempt.status !== 'running') {
    throw new FactoryError(
      'conflict',
      `Step "${attempt.stepId}" is ${attempt.status}, not running`,
    )
  }
  return ticketStatus({ status: 'waiting', next: null })
}

/** A claimed pending attempt starts running. */
export function startAttempt(history: readonly AttemptState[]): TicketStatus {
  const attempt = openAttempt(history)
  if (attempt.status !== 'pending') {
    throw new FactoryError(
      'conflict',
      `Step "${attempt.stepId}" is ${attempt.status}, not pending`,
    )
  }
  return ticketStatus({ status: 'running', next: null })
}

export function stepOf(workflow: Workflow, stepId: string): Step {
  const step = workflow.steps.find((candidate) => candidate.id === stepId)
  if (!step) {
    throw new FactoryError(
      'invalid',
      `Workflow "${workflow.name}" has no step "${stepId}"; its steps are ${workflow.steps
        .map((candidate) => candidate.id)
        .join(', ')}`,
    )
  }
  return step
}

/** Rejects a workflow whose steps need capabilities the repository does not provide. */
export function checkCapabilities(
  workflow: Workflow,
  repository: {
    readonly slug: string
    readonly capabilities: readonly string[]
  },
): void {
  const missing = missingCapabilities(workflow, repository.capabilities)
  if (missing.length === 0) return
  const details = missing
    .map(
      ({ capability, steps }) =>
        `${capability} (needed by ${steps.join(', ')})`,
    )
    .join('; ')
  throw new FactoryError(
    'invalid',
    `Workflow "${workflow.name}" needs capabilities that ${repository.slug} does not provide: ${details}. Choose a workflow without these needs, or add them to the repository's kit.`,
  )
}

/** A git branch name for a ticket, such as `kipster/12-fix-login-redirect`. */
export function branchName(number: number, title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '')
  return slug === '' ? `kipster/${number}` : `kipster/${number}-${slug}`
}

function route(
  workflow: Workflow,
  history: readonly AttemptState[],
  step: Step,
  outcome: string,
  summary: string,
): Transition {
  const runs = runsOf(history, step.id) + 1
  const next = nextStep(workflow, step.id, outcome, runs)
  const close: Closing = { status: 'finished', outcome, next }
  switch (next.to) {
    case 'step':
      return transition(close, openStep(workflow, next.stepId))
    case 'finish':
    case 'cancel':
      return transition(close, null)
    case 'ask':
      return transition(
        close,
        ask(
          step.id,
          next.because,
          askSummary(step, outcome, summary, runs, next.because),
        ),
      )
  }
}

function askSummary(
  step: Step,
  outcome: string,
  summary: string,
  runs: number,
  because: TicketAskReason,
): string {
  switch (because) {
    case 'needs-decision':
      return `${step.id} needs a decision: ${summary}`
    case 'limit':
      return `${step.id} reported ${outcome} after ${runs} runs, reaching its limit of ${step.limit}.`
    case 'routed':
      return `${step.id} reported ${outcome}, which this workflow sends to you.`
    default:
      return `${step.id} reported ${outcome}, which has no route in this workflow.`
  }
}

function ask(
  stepId: string,
  reason: TicketAskReason,
  summary: string,
): Opening {
  return {
    stepId,
    status: 'waiting',
    waitingFor: 'ask',
    askReason: reason,
    summary,
  }
}

function transition(close: Closing, open: Opening | null): Transition {
  return {
    close,
    open,
    status: ticketStatus(open ? { status: open.status, next: null } : close),
  }
}

function openAttempt(history: readonly AttemptState[]): AttemptState {
  const latest = history.at(-1)
  if (
    !latest ||
    !(OPEN_STATUSES as readonly string[]).includes(latest.status)
  ) {
    throw new FactoryError('conflict', 'The ticket has already ended')
  }
  return latest
}

function isRunning(attempt: AttemptState): boolean {
  return (
    attempt.status === 'running' ||
    (attempt.status === 'waiting' &&
      (attempt.waitingFor === 'pull-request-merge' ||
        attempt.waitingFor === 'pull-request-checks'))
  )
}
