import type { DecisionRecord } from './decisions.ts'
import type { MergeGate } from './merge-gate.ts'

export const mergeQuestion = {
  question: 'Is this change safe to merge without the owner reviewing it?',
  options: {
    merge: 'Safe to merge with the current independent proof and CI.',
    owner: 'The owner should review and merge this change.',
  },
  bands: { act: 0.9, confirm: 0.6 },
}
export function mergePolicy(
  enabled: boolean,
  gate: MergeGate,
  decision?: DecisionRecord,
): 'wait' | 'ask' | 'merge' | 'confirm' | 'owner' {
  if (!gate.ready) return 'wait'
  if (!enabled || gate.needsOwner.length) return 'owner'
  if (!decision || decision.facts.headCommit !== gate.facts.head) return 'ask'
  if (decision.mergeError || decision.mergeRequestedAt) return 'owner'
  if (
    decision.finalOption === 'merge' &&
    (decision.band === 'acted' || decision.decidedBy === 'owner')
  )
    return 'merge'
  if (
    decision.band === 'confirm' &&
    decision.answer?.choice === 'merge' &&
    !decision.finalOption
  )
    return 'confirm'
  return 'owner'
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
