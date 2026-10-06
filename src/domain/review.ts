import type { Artifact } from './records.ts'
import type { Attempt } from './records.ts'
import type { Workflow } from './workflow.ts'

export function reviewHistory(
  input: {
    workflow: Workflow
    attempts: readonly Attempt[]
    artifacts: readonly Artifact[]
  },
  stepId: string,
) {
  const rounds = input.attempts.filter(
    (attempt) =>
      attempt.stepId === stepId &&
      attempt.status === 'finished' &&
      attempt.waitingFor === null,
  )
  return {
    round: rounds.length + 1,
    firstCommit: rounds[0]?.headCommit ?? null,
    lastCommit: rounds.at(-1)?.headCommit ?? null,
    findings: input.artifacts.filter(
      (artifact) =>
        artifact.kind === 'finding' &&
        rounds.some((attempt) => attempt.id === artifact.attemptId),
    ),
  }
}

export function findingTitle(title: string): string {
  return title.replace(/^\[[^\]]+\] /, '')
}

export function openReviewFindings(input: {
  workflow: Workflow
  attempts: readonly Attempt[]
  artifacts: readonly Artifact[]
}): readonly Artifact[] {
  const latest = input.attempts.findLast(
    (attempt) =>
      attempt.status === 'finished' &&
      input.workflow.steps.some(
        (step) =>
          step.id === attempt.stepId &&
          step.kind === 'agent' &&
          step.role === 'reviewer',
      ),
  )
  return latest?.outcome === 'changes-needed'
    ? input.artifacts.filter(
        (artifact) =>
          artifact.attemptId === latest.id && artifact.kind === 'finding',
      )
    : []
}

export function exhaustedReview(
  input: { workflow: Workflow; attempts: readonly Attempt[] },
  attempt: Attempt,
): boolean {
  const reviewStep = input.workflow.steps.find(
    (step) => step.id === attempt.stepId,
  )
  return (
    input.workflow.steps.some(
      (step) => step.kind === 'agent' && step.role === 'lead',
    ) &&
    reviewStep?.kind === 'agent' &&
    reviewStep.role === 'reviewer' &&
    attempt.status === 'finished' &&
    attempt.outcome === 'changes-needed' &&
    input.attempts.filter(
      (previous) =>
        previous.stepId === reviewStep.id &&
        previous.status === 'finished' &&
        previous.waitingFor === null &&
        previous.id <= attempt.id,
    ).length >= (reviewStep.limit ?? 5) &&
    attempt.next?.to === 'step' &&
    input.workflow.steps.some(
      (target) =>
        target.id ===
          (attempt.next?.to === 'step' ? attempt.next.stepId : null) &&
        target.kind === 'system' &&
        target.action === 'maintain-pr',
    )
  )
}
