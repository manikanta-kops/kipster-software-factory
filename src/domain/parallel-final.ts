import {
  afterFailure,
  afterResult,
  type AttemptState,
  type StepResult,
} from './lifecycle.ts'
import { nextStep } from './routing.ts'
import type { Step, Workflow } from './workflow.ts'

export function parallelReviewer(
  workflow: Workflow,
  tester: Step,
): Step | null {
  if (tester.kind !== 'agent' || tester.role !== 'tester') return null
  const reviewer =
    workflow.steps[workflow.steps.findIndex((s) => s.id === tester.id) + 1]
  return reviewer?.kind === 'agent' &&
    reviewer.role === 'reviewer' &&
    nextStep(workflow, tester.id, 'passed', 1).to === 'step' &&
    (tester.routes.passed === undefined || tester.routes.passed === reviewer.id)
    ? reviewer
    : null
}

export function afterParallelResults(
  workflow: Workflow,
  testerHistory: readonly AttemptState[],
  reviewerHistory: readonly AttemptState[],
  tester: StepResult | null,
  reviewer: StepResult | null,
  error = 'Missing paired verdict',
) {
  if (!tester || !reviewer) {
    const survivor = tester ?? reviewer
    const failure = afterFailure(testerHistory, error)
    const tested = tester
      ? afterResult(workflow, testerHistory, tester)
      : failure
    const chosen =
      survivor?.outcome === 'changes-needed'
        ? afterResult(
            workflow,
            tester ? testerHistory : reviewerHistory,
            survivor,
          )
        : failure
    return { ...chosen, close: { ...tested.close, next: chosen.close.next } }
  }
  const tested = afterResult(workflow, testerHistory, tester)
  const reviewed = afterResult(workflow, reviewerHistory, reviewer)
  const candidates = [
    ...(tester.outcome === 'passed' ? [] : [tested]),
    ...(reviewer.outcome === 'passed' ? [] : [reviewed]),
  ]
  const reviewIndex = workflow.steps.findIndex(
    (step) => step.id === reviewerHistory.at(-1)!.stepId,
  )
  // A stop or a remaining correction takes precedence over an exhausted forward route.
  const chosen =
    candidates.find((t) => ['ask', 'cancel'].includes(t.close.next!.to)) ??
    candidates.find((t) => {
      const next = t.close.next
      return (
        next?.to === 'step' &&
        workflow.steps.findIndex((s) => s.id === next.stepId) <= reviewIndex
      )
    }) ??
    candidates[0] ??
    reviewed
  return { ...chosen, close: { ...tested.close, next: chosen.close.next } }
}
