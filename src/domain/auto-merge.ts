import type { MergeGate } from './merge-gate.ts'

export function mergePolicy(
  enabled: boolean,
  gate: MergeGate,
): 'wait' | 'merge' | 'owner' {
  if (!gate.ready) return 'wait'
  if (!enabled || gate.needsOwner.length) return 'owner'
  const current = (verdict: typeof gate.facts.tester) =>
    verdict?.status === 'finished' &&
    verdict.outcome === 'passed' &&
    verdict.commit === gate.facts.head
  return gate.facts.hasTester &&
    gate.facts.hasReviewer &&
    current(gate.facts.tester) &&
    current(gate.facts.reviewer ?? null) &&
    !gate.facts.reviewer?.ownerReview
    ? 'merge'
    : 'owner'
}
export function settledCI<T extends { state: string }>(
  checks: T,
  since: string,
  minutes: number,
  now: number,
): T {
  return checks.state === 'none' && now - Date.parse(since) < minutes * 60_000
    ? { ...checks, state: 'pending' }
    : checks
}
