import type { Artifact, Attempt, Ticket } from './records.ts'

/** Stored on tickets that skipped their tester before every task was checked. */
export interface SkippedStep {
  readonly stepId: string
  readonly missingCapabilities: readonly string[]
}

export interface CheckFacts {
  readonly ticket: Pick<Ticket, 'skippedSteps'>
  readonly workflow: {
    readonly steps: readonly {
      readonly id: string
      readonly kind: string
      readonly role?: string
    }[]
  }
  readonly attempts: readonly Attempt[]
  readonly artifacts: readonly Artifact[]
}

function latestCheck(facts: CheckFacts): Attempt | undefined {
  const testers = new Set(
    facts.workflow.steps
      .filter((step) => step.kind === 'agent' && step.role === 'tester')
      .map((step) => step.id),
  )
  return facts.attempts.findLast(
    (attempt) => testers.has(attempt.stepId) && attempt.waitingFor === null,
  )
}

/** Items the latest checker reported it could not prove. */
export function uncheckedItems(facts: CheckFacts): Artifact[] {
  const check = latestCheck(facts)
  return facts.artifacts.filter(
    (artifact) =>
      artifact.attemptId === check?.id &&
      artifact.scenarioResult === 'unverified',
  )
}

/** Stored on tickets from before every task was checked. */
export function skippedReasons(ticket: Pick<Ticket, 'skippedSteps'>): string[] {
  return (ticket.skippedSteps ?? []).map(
    (step) =>
      `Untested: no ${step.missingCapabilities.join(', ')} capability (skipped ${step.stepId})`,
  )
}

export function untestedReasons(facts: CheckFacts): string[] {
  return [
    ...new Set([
      ...skippedReasons(facts.ticket),
      ...uncheckedItems(facts).map(
        (artifact) =>
          `Unverified by ${artifact.stepId}: ${artifact.scenario ?? artifact.title}`,
      ),
    ]),
  ]
}

/** One sentence for a lead's task report: the checker's verdict on the landed work. */
export function checkerVerdict(facts: CheckFacts): string {
  const check = latestCheck(facts)
  const reasons = untestedReasons(facts)
  if (!check)
    return reasons.length
      ? `Landed untested. ${reasons.join('; ')}.`
      : 'No checker ran.'
  const verdict = `Checker ${check.stepId} ${check.outcome ?? check.status}${check.headCommit ? ` at ${check.headCommit}` : ''}`
  return reasons.length
    ? `${verdict} with unverified items. ${reasons.join('; ')}.`
    : `${verdict}.`
}
