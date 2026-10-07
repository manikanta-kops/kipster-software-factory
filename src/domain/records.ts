// The factory's records as the store returns them and the API sends them.
// Timestamps are ISO 8601 strings so the same shapes work on both sides of the wire.
import type { TicketSummary } from './summary.ts'
import type { AgentChoice } from './catalog.ts'
import type { Next } from './routing.ts'
import type { SkippedStep } from './task-testing.ts'

export const REPOSITORY_STATUSES = ['pending', 'ready', 'failed'] as const
export type RepositoryStatus = (typeof REPOSITORY_STATUSES)[number]

export const TICKET_STATUSES = [
  'queued',
  'running',
  'needs-you',
  'done',
  'cancelled',
] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]

export const ATTEMPT_STATUSES = [
  'pending',
  'running',
  'waiting',
  'finished',
  'failed',
  'interrupted',
] as const
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number]

/** Attempts in these states are open; a ticket has at most one open attempt. */
export const OPEN_STATUSES = ['pending', 'running', 'waiting'] as const
export type OpenStatus = (typeof OPEN_STATUSES)[number]

export const WAITING_FOR = [
  'human',
  'decision',
  'other-repo',
  'ask',
  'pull-request-merge',
  'pull-request-checks',
  'tasks',
] as const
export type WaitingFor = (typeof WAITING_FOR)[number]

/** Why a ticket asks you: the routing reasons, plus a failed step or a step interrupted twice. */
export const ASK_REASONS = [
  'needs-decision',
  'routed',
  'unrouted',
  'limit',
  'failed',
  'interrupted',
] as const
export type TicketAskReason = (typeof ASK_REASONS)[number]

export const ARTIFACT_KINDS = [
  'plan',
  'comment',
  'finding',
  'evidence',
  'log',
  'note',
  'decision',
] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

/** `owner/name`, as on GitHub. */
export const REPOSITORY_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export const HUMAN_CHOICES = ['approved', 'changes-needed', 'rejected'] as const
export type HumanChoice = (typeof HUMAN_CHOICES)[number]

export const EVENT_KINDS = [
  'repository.created',
  'repository.ready',
  'repository.failed',
  'repository.retried',
  'repository.policy',
  'pull-request.merge-requested',
  'pull-request.merged',
  'post-merge.checked',
  'ticket.created',
  'ticket.linked',
  'task.updated',
  'ticket.status',
  'ticket.summary',
  'lesson.proposed',
  'lesson.decided',
  'ticket.pull-request',
  'attempt.queued',
  'attempt.claimed',
  'attempt.released',
  'attempt.started',
  'attempt.waiting',
  'attempt.finished',
  'attempt.failed',
  'attempt.interrupted',
  'artifact.added',
  'artifact.pruned',
  'merge-gate.updated',
  'decision.made',
  'ask.resolved',
] as const
export type EventKind = (typeof EVENT_KINDS)[number]

export interface RepositoryKit {
  readonly status: 'missing' | 'valid' | 'invalid'
  readonly error: string | null
  readonly capabilities: readonly string[]
}

export interface Repository {
  readonly autoMerge?: boolean
  readonly id: number
  /** `owner/name` */
  readonly slug: string
  readonly cloneUrl: string
  readonly defaultBranch: string
  readonly status: RepositoryStatus
  readonly lastError: string | null
  /** Compatibility alias of kit.capabilities. */
  readonly capabilities: readonly string[]
  readonly kit: RepositoryKit
  readonly createdAt: string
  readonly updatedAt: string
}

/** What a ticket is waiting for, taken from its open waiting attempt. */
export interface Waiting {
  readonly attemptId: number
  readonly stepId: string
  readonly for: WaitingFor
  /** Set when waiting for `ask`. */
  readonly askReason: TicketAskReason | null
  /** For asks, a sentence saying why the ticket stopped. */
  readonly summary: string | null
  readonly since: string
}

export function defaultLightsOut(workflow: string): boolean {
  return workflow === 'lead' || workflow === 'program-lead'
}

export interface Ticket {
  readonly summary: TicketSummary | null
  readonly summaryAt: string | null
  readonly skippedSteps?: readonly SkippedStep[]
  readonly lightsOut: boolean
  readonly id: number
  /** Shown to people as #number. */
  readonly number: number
  readonly repository: { readonly id: number; readonly slug: string }
  readonly workflow: { readonly name: string; readonly version: string }
  readonly title: string
  /** Markdown. */
  readonly body: string
  readonly branch: string
  readonly pullRequestUrl: string | null
  /** The step of the latest attempt; after the ticket ends, the step it ended at. */
  readonly currentStep: string
  readonly status: TicketStatus
  readonly waiting: Waiting | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** One run of one step. */
export interface Attempt {
  readonly ownerReview?: { readonly reason: string } | null
  readonly reproductionAttemptId?: number | null
  readonly id: number
  readonly ticketId: number
  readonly stepId: string
  readonly status: AttemptStatus
  /** The outcome the step reported, or the human's choice. */
  readonly outcome: string | null
  readonly summary: string | null
  /** Who ran it, such as `claude-code`, `codex` or `system`; `human` for decisions and resolved asks. */
  readonly executor: string | null
  /** The CLI, model and effort an agent attempt ran with; absent before it started. */
  readonly agent?: AgentChoice | null
  readonly error: string | null
  /** What a waiting attempt waits for. Kept after it finishes, so asks and human steps stay recognisable. */
  readonly waitingFor: WaitingFor | null
  readonly askReason: TicketAskReason | null
  /** Where the ticket went when this attempt closed; null while open, and for failed or auto-retried attempts. */
  readonly next: Next | null
  readonly createdAt: string
  /** Set when a scheduler claims a pending attempt. */
  readonly claimedAt: string | null
  readonly startedAt: string | null
  readonly waitingSince: string | null
  /** Exact branch commit at completion; null when no commit was observed. */
  readonly headCommit: string | null
  readonly finishedAt: string | null
}

export interface AgentDecision {
  readonly chose: string
  readonly alternative: string
  readonly reason: string
}

export interface Artifact {
  readonly file?: string | null
  readonly decision?: AgentDecision | null
  /** Factory-observed proof surface commit; agents cannot set it in result.json. */
  readonly observedCommit?: string | null
  readonly scenarioResult?:
    'passed' | 'failed' | 'unverified' | 'reproduced' | null
  readonly scenario?: string | null
  readonly prunedAt?: string | null
  readonly retentionDays?: number | null
  readonly mediaType: string
  readonly id: number
  readonly ticketId: number
  readonly attemptId: number
  readonly stepId: string
  readonly kind: ArtifactKind
  readonly title: string
  /** Markdown stored in the database; null for file artifacts. */
  readonly content: string | null
  /** A file inside the factory home (absolute, or relative to the home); null for content artifacts. */
  readonly path: string | null
  readonly createdAt: string
}

export interface FactoryEvent {
  readonly id: number
  readonly ticketId: number | null
  readonly ticketNumber: number | null
  readonly kind: EventKind
  readonly data: Readonly<Record<string, unknown>>
  readonly createdAt: string
}

export interface TicketLink {
  readonly id: number
  readonly attemptId: number
  readonly request: {
    readonly repository: string
    readonly title: string
    readonly body: string
    readonly workflow: string
  }
  readonly original: Pick<
    Ticket,
    'id' | 'number' | 'title' | 'repository' | 'status' | 'pullRequestUrl'
  >
  readonly linked: Pick<
    Ticket,
    'id' | 'number' | 'title' | 'repository' | 'status' | 'pullRequestUrl'
  >
  readonly mergeCommit: string | null
  readonly resolvedAt: string | null
}

export const TASK_STATUSES = [
  'pending',
  'running',
  'parked',
  'pr-ready',
  'merged',
  'left-open',
  'conflict',
  'failed',
  'cancelled',
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

/** One task a lead handed out, run as a child ticket. */
export interface LeadTask {
  readonly id: number
  /** The lead's ticket. */
  readonly ticketId: number
  /** The lead attempt that asked for it. */
  readonly attemptId: number
  readonly key: string
  readonly title: string
  readonly instructions: string
  /** `branch` merges into the lead's branch; `pr` opens its own pull request. */
  readonly land: 'branch' | 'pr'
  readonly workflow: string
  readonly agent: AgentChoice | null
  readonly status: TaskStatus
  /** The lead's call on a ready pull request. */
  readonly decision: 'merge' | 'leave-open' | null
  /** What happened, in a sentence, once the task is past running. */
  readonly result: string | null
  /** The lead branch commit a branch task started from. */
  readonly baseCommit: string | null
  readonly child: {
    readonly skippedSteps?: readonly SkippedStep[]
    readonly id: number
    readonly number: number
    readonly status: TicketStatus
    readonly branch: string
    readonly currentStep: string
    readonly pullRequestUrl: string | null
    readonly waiting: Waiting | null
  } | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** On a child ticket: the lead ticket and task it belongs to. */
export interface ParentTask {
  readonly key: string
  readonly land: 'branch' | 'pr'
  readonly status: TaskStatus
  readonly parent: Pick<Ticket, 'id' | 'number' | 'title' | 'status'>
}
