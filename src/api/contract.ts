import type { TicketSummary } from '../domain/summary.ts'
export type { TicketSummary } from '../domain/summary.ts'
import type { TicketUsage } from '../domain/usage.ts'
export type { TaskUsage, TicketUsage, UsageTotals } from '../domain/usage.ts'
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
  LeadTask,
  ParentTask,
  Repository,
  Ticket,
  TicketLink,
} from '../domain/records.ts'
import type { Next } from '../domain/routing.ts'
import type { AgentChoice, RoleName } from '../domain/catalog.ts'
import type { Settings, TicketAgents } from '../domain/settings.ts'

export type {
  Artifact,
  ArtifactKind,
  Attempt,
  AttemptStatus,
  EventKind,
  FactoryEvent,
  HumanChoice,
  LeadTask,
  ParentTask,
  Repository,
  RepositoryStatus,
  RepositoryKit,
  Ticket,
  TicketAskReason,
  TicketStatus,
  TicketLink,
  TaskStatus,
  Waiting,
  WaitingFor,
} from '../domain/records.ts'
export type { Next } from '../domain/routing.ts'
export type { AgentChoice } from '../domain/catalog.ts'
export type {
  Settings,
  TicketAgents,
  WorkflowOverride,
} from '../domain/settings.ts'

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
  /** Whether people can select this workflow on New ticket. */
  readonly selectable?: boolean
  readonly name: string
  readonly version: string
  readonly description: string
  readonly steps: readonly StepSummary[]
  /** `file` workflows load from the factory's workflow directory; `upload` ones were added through the API. */
  readonly origin: 'file' | 'upload'
}

export interface WorkflowsResponse {
  readonly workflows: readonly WorkflowSummary[]
}

// POST /api/workflows
export interface UploadWorkflowRequest {
  /** The workflow file's YAML text. */
  readonly source: string
}

export interface WorkflowResponse {
  readonly workflow: WorkflowSummary
}

// DELETE /api/workflows/:name removes an uploaded workflow. Workflow files are
// refused (409), as is a workflow unfinished tickets use (409, WorkflowInUseResponse).
export interface RemoveWorkflowResponse {
  readonly removed: string
}

export interface WorkflowInUseResponse extends ErrorResponse {
  /** Unfinished tickets that run the workflow, or leads with a task that will. */
  readonly tickets: readonly number[]
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
  readonly tickets: readonly ListedTicket[]
}

export interface ListedTicket extends Ticket {
  /** On a child ticket, the lead task it runs. */
  readonly task?: {
    readonly key: string
    readonly leadNumber: number
    /** The child ticket number of the later task that retried this one, when it ended without landing. */
    readonly replacedBy?: number | null
  } | null
}

// POST /api/tickets (201, TicketResponse)
export interface CreateTicketRequest {
  /** Override agent choices for this ticket and its lead child tickets. */
  readonly agents?: TicketAgents | undefined
  /** Defaults on for lead and program-lead, off for other workflows. */
  readonly lightsOut?: boolean | undefined
  /** The repository's `owner/name`. */
  readonly repository: string
  /** Other registered repositories available as read-only context. */
  readonly dependencies?: readonly string[] | undefined
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
  readonly summary: TicketSummary | null
  readonly dependencies?: readonly Repository[]
  readonly links?: readonly TicketLink[]
  /** A lead ticket's tasks, oldest first. */
  readonly tasks?: readonly LeadTask[]
  /** On a child ticket, the lead ticket and task it runs. */
  readonly parentTask?: ParentTask | null
  readonly mergeGate?: GateSnapshot | null
  readonly evidenceIndex?: readonly ScenarioEvidence[]
  readonly decisions?: readonly DecisionRecord[]
  /** Tokens and time over finished step runs; on a lead ticket, also per task. */
  readonly usage?: TicketUsage
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

// POST /api/repositories/:id/auto-merge
export interface AutoMergeRequest {
  readonly enabled: boolean
}

// GET /api/settings, and the answer to POST /api/settings
export interface SettingsResponse {
  /** What steps that start now run with. */
  readonly settings: Settings
  /** `config`: config.json's values or defaults, nothing saved yet; `saved`: edited here, config.json's values are ignored. */
  readonly source: 'config' | 'saved'
  readonly updatedAt: string | null
  readonly choices: {
    readonly clis: readonly AgentChoice['cli'][]
    readonly efforts: readonly NonNullable<AgentChoice['effort']>[]
    readonly roles: readonly RoleName[]
  }
  /** Workflow names an override may use. */
  readonly workflows: readonly string[]
}

// POST /api/settings takes the whole document; a 400 names each invalid field in `issues`.
export type SettingsRequest = Settings

export type { SkippedStep } from '../domain/task-testing.ts'

export type { Lesson, LessonStatus } from '../domain/lessons.ts'
export interface LessonsResponse {
  readonly lessons: readonly import('../domain/lessons.ts').Lesson[]
}
export interface LessonResponse {
  readonly lesson: import('../domain/lessons.ts').Lesson
}
export interface RetireLessonRequest {
  readonly reason: string
}
