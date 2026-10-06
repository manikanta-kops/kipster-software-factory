import { roles, type Role } from './catalog.ts'
import type { LeadTask, Ticket } from './records.ts'
import type { Workflow } from './workflow.ts'

export interface SkippedStep {
  readonly stepId: string
  readonly missingCapabilities: readonly string[]
}

export function skippableTaskSteps(
  workflow: Workflow,
  capabilities: readonly string[],
  isLeadTask: boolean,
): SkippedStep[] {
  if (!isLeadTask) return []
  return workflow.steps.flatMap((step) => {
    if (step.kind !== 'agent') return []
    const role: Role = roles[step.role]
    if (!role.skipMissingNeedsInTaskWorkflows?.includes(workflow.name))
      return []
    const missingCapabilities = step.needs.filter(
      (need) => !capabilities.includes(need),
    )
    return missingCapabilities.length
      ? [{ stepId: step.id, missingCapabilities }]
      : []
  })
}

/** Routes to a removed step continue at the next retained step in file order. */
export function withoutSkippedSteps(
  workflow: Workflow,
  skipped: readonly SkippedStep[],
): Workflow {
  const ids = new Set(skipped.map((step) => step.stepId))
  if (!ids.size) return workflow
  const target = (id: string): string => {
    if (!ids.has(id)) return id
    const index = workflow.steps.findIndex((step) => step.id === id)
    return (
      workflow.steps.slice(index + 1).find((step) => !ids.has(step.id))?.id ??
      'finish'
    )
  }
  return {
    ...workflow,
    steps: workflow.steps
      .filter((step) => !ids.has(step.id))
      .map((step) => ({
        ...step,
        routes: Object.fromEntries(
          Object.entries(step.routes).map(([outcome, id]) => [
            outcome,
            target(id),
          ]),
        ),
      })),
  }
}

export function untestedReasons(detail: {
  ticket: Pick<Ticket, 'skippedSteps'>
  tasks?: readonly LeadTask[]
}): string[] {
  const reasons = (detail.ticket.skippedSteps ?? []).map(
    (step) =>
      `Untested: no ${step.missingCapabilities.join(', ')} capability (skipped ${step.stepId})`,
  )
  for (const task of detail.tasks ?? []) {
    if (task.status !== 'merged' || !task.child?.skippedSteps?.length) continue
    reasons.push(
      `Untested task ${task.key}: no ${[...new Set(task.child.skippedSteps.flatMap((step) => step.missingCapabilities))].join(', ')} capability`,
    )
  }
  return reasons
}
