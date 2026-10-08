import { type Exit, LIMIT, NEEDS_DECISION } from './catalog.ts'
import {
  type Step,
  stepContract,
  routeKeys,
  type Workflow,
} from './workflow.ts'

export type AskReason = 'needs-decision' | 'routed' | 'unrouted' | 'limit'

/** Where a ticket goes after a step reports an outcome. */
export type Next =
  | { readonly to: 'step'; readonly stepId: string }
  | { readonly to: 'finish' }
  | { readonly to: 'cancel' }
  | { readonly to: 'ask'; readonly because: AskReason }

export function firstStep(workflow: Workflow): Step {
  const step = workflow.steps[0]
  if (!step) throw new Error(`Workflow "${workflow.name}" has no steps`)
  return step
}

/**
 * Resolves the next move for a ticket.
 *
 * `sendBacks` counts finished reports with this outcome, including this one.
 * Unrouted outcomes follow fixed defaults: the step's success outcome continues
 * to the next step (or finishes after the last one), `rejected` cancels, and
 * anything else pauses the ticket for a human.
 */
export function nextStep(
  workflow: Workflow,
  stepId: string,
  outcome: string,
  sendBacks: number,
): Next {
  const index = indexOf(workflow, stepId)
  const step = workflow.steps[index] as Step
  if (!routeKeys(step).includes(outcome) || outcome === LIMIT) {
    throw new Error(`Step "${stepId}" cannot report "${outcome}"`)
  }

  const target = targetFor(workflow, index, outcome)
  const sendsBack =
    target.to === 'step' && indexOf(workflow, target.stepId) <= index
  const limit = stepLimit(step)
  if (
    sendsBack &&
    !stepContract(step).limitExemptOutcomes?.includes(outcome) &&
    limit !== undefined &&
    sendBacks >= limit
  ) {
    const limitRoute = step.routes[LIMIT]
    return limitRoute === undefined
      ? { to: 'ask', because: 'limit' }
      : resolve(limitRoute, 'limit')
  }
  return target
}

/** Every outcome a step can report and where it leads, ignoring limits. */
export function describeRoutes(
  workflow: Workflow,
  step: Step,
): readonly { readonly outcome: string; readonly next: Next }[] {
  const index = indexOf(workflow, step.id)
  return routeKeys(step).map((outcome) => ({
    outcome,
    next:
      outcome === LIMIT
        ? resolve(step.routes[LIMIT] ?? 'ask', 'limit')
        : targetFor(workflow, index, outcome),
  }))
}

function targetFor(workflow: Workflow, index: number, outcome: string): Next {
  const step = workflow.steps[index] as Step
  const route = step.routes[outcome]
  if (route !== undefined) return resolve(route)
  if (outcome === NEEDS_DECISION)
    return { to: 'ask', because: 'needs-decision' }
  if (outcome === 'rejected') return { to: 'cancel' }
  if (outcome === stepContract(step).success) {
    const following = workflow.steps[index + 1]
    return following ? { to: 'step', stepId: following.id } : { to: 'finish' }
  }
  return { to: 'ask', because: 'unrouted' }
}

function resolve(target: string, because: AskReason = 'routed'): Next {
  switch (target as Exit) {
    case 'finish':
      return { to: 'finish' }
    case 'cancel':
      return { to: 'cancel' }
    case 'ask':
      return { to: 'ask', because }
    default:
      return { to: 'step', stepId: target }
  }
}

function indexOf(workflow: Workflow, stepId: string): number {
  const index = workflow.steps.findIndex((step) => step.id === stepId)
  if (index < 0) {
    throw new Error(`Workflow "${workflow.name}" has no step "${stepId}"`)
  }
  return index
}

export function stepLimit(step: Step): number | undefined {
  return (
    step.limit ??
    (step.kind === 'agent' && step.role === 'reviewer' ? 5 : undefined)
  )
}
