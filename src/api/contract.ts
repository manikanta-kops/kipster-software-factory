// Response shapes shared by the server and the web app. Change by addition only.
import type { Next } from '../domain/routing.ts'

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
