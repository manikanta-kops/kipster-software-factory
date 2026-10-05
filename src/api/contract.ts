import type { GateSnapshot } from '../domain/merge-gate.ts'
import type { ScenarioEvidence } from '../domain/evidence.ts'
import type { DecisionRecord, DecisionStepCounts } from '../domain/decisions.ts'
export type { DecisionRecord } from '../domain/decisions.ts'
// Response shapes shared by the server and the web app. Change by addition only.
import type {
  Artifact,
  Attempt,
  FactoryEvent,
  HumanChoice,
  Repository,
  Ticket,
} from '../domain/records.ts'
import type { Next } from '../domain/routing.ts'

export type {
  Artifact,
  ArtifactKind,
  Attempt,
  AttemptStatus,
  EventKind,
  FactoryEvent,
  HumanChoice,
  Repository,
  RepositoryStatus,
  RepositoryKit,
  Ticket,
  TicketAskReason,
  TicketStatus,
  Waiting,
  WaitingFor,
} from '../domain/records.ts'
export type { Next } from '../domain/routing.ts'

export interface HealthResponse {
  readonly status: 'ok'
  readonly database: 'ok'
}

export interface RouteSummary {
  readonly outcome: string
  readonly next: Next
}

export interface StepSummary {
  readonly id: string
  readonly kind: 'agent' | 'human' | 'system'
  /** The role for agent steps, the action for system steps, absent for human steps. */
  readonly does?: string
  /** The outcome that moves the ticket forward; absent for decisions, which route every answer. */
  readonly success?: string
  readonly instructions?: string
  readonly limit?: number
  readonly needs: readonly string[]
  readonly routes: readonly RouteSummary[]
}

export interface WorkflowSummary {
  readonly name: string
  readonly version: string
  readonly description: string
  readonly steps: readonly StepSummary[]
}

export interface WorkflowsResponse {
  readonly workflows: readonly WorkflowSummary[]
}

/** Every 4xx and 5xx response. */
export interface ErrorResponse {
  readonly error: string
  /** Field-level problems for an invalid request body or query. */
  readonly issues?: readonly string[]
}

// GET /api/repositories
export interface RepositoriesResponse {
  readonly repositories: readonly Repository[]
}

// POST /api/repositories (201)
export interface CreateRepositoryRequest {
  /** `owner/name` */
  readonly slug: string
  /** Default: `https://github.com/<slug>.git` */
  readonly cloneUrl?: string | undefined
  /** Default: `main` */
  readonly defaultBranch?: string | undefined
}

export interface RepositoryResponse {
  readonly repository: Repository
}

// GET /api/tickets?status=needs-you,queued
export interface TicketsResponse {
  /** Most recently changed first. */
  readonly tickets: readonly Ticket[]
}

// POST /api/tickets (201, TicketResponse)
export interface CreateTicketRequest {
  /** The repository's `owner/name`. */
  readonly repository: string
  /** A workflow name; the ticket keeps the library's current version of it. */
  readonly workflow: string
  readonly title: string
  /** Markdown. */
  readonly body?: string | undefined
}

export interface TicketStepSummary extends StepSummary {
  /** Finished runs of this step; what limits count. */
  readonly runs: number
}

export interface TicketWorkflowSummary {
  readonly name: string
  /** The version this ticket runs, which may be older than the library's. */
  readonly version: string
  readonly description: string
  readonly steps: readonly TicketStepSummary[]
}

// GET /api/tickets/:number, and the answer to every ticket action
export interface TicketResponse {
  readonly mergeGate?: GateSnapshot | null
  readonly evidenceIndex?: readonly ScenarioEvidence[]
  readonly decisions?: readonly DecisionRecord[]
  readonly ticket: Ticket
  readonly workflow: TicketWorkflowSummary
  /** Oldest first; the last one is open unless the ticket has ended. */
  readonly attempts: readonly Attempt[]
  /** Oldest first. Content artifacts carry their markdown; files are served by GET /api/artifacts/:id. */
  readonly artifacts: readonly Artifact[]
  /** Oldest first. */
  readonly events: readonly FactoryEvent[]
}

// POST /api/tickets/:number/decision
export interface DecisionRequest {
  /** The waiting human attempt (ticket.waiting.attemptId); a stale id gets 409. */
  readonly attemptId: number
  readonly choice: HumanChoice
  /** Required for changes-needed. Stored as a comment artifact. */
  readonly comment?: string | undefined
}

// POST /api/tickets/:number/resolve
export type ResolveRequest = {
  /** The waiting ask attempt (ticket.waiting.attemptId); a stale id gets 409. */
  readonly attemptId: number
  /** Stored as a note artifact for later steps. */
  readonly note?: string | undefined
} & (
  | { readonly action: 'retry' }
  | { readonly action: 'move'; readonly stepId: string }
  | { readonly action: 'cancel' }
)

// POST /api/tickets/:number/cancel
export interface CancelRequest {
  /** Stored as a note artifact. */
  readonly reason?: string | undefined
}

/**
 * GET /api/events is a Server-Sent Events stream. It first sends an `event: ready`
 * message with `{ lastEventId }`, then one unnamed message per event with `id` set and
 * a FactoryEvent as data. Reconnecting with Last-Event-ID (or `?after=<id>`) replays
 * everything after that id; without either, the stream starts at the latest event.
 */
export type EventMessage = FactoryEvent

export interface EventStreamReady {
  readonly lastEventId: number
}

// GET /api/decisions: recent outcomes and all-time counts for each saved workflow step.
export interface DecisionsResponse {
  readonly decisions: readonly DecisionRecord[]
  readonly steps: readonly DecisionStepCounts[]
}
// POST /api/tickets/:number/option
export interface OptionRequest {
  readonly attemptId: number
  readonly option: string
}
