import { decideParams } from './catalog.ts'
import { FactoryError } from './errors.ts'

export type DecisionBand = 'acted' | 'confirm' | 'owner' | 'no-key' | 'error'
export interface DecisionFacts {
  readonly ticket: { readonly title: string; readonly body: string }
  readonly base: { readonly ref: string; readonly commit: string }
  readonly headCommit: string
  readonly files: readonly {
    readonly path: string
    readonly added: number | null
    readonly removed: number | null
  }[]
  readonly verdicts: readonly {
    readonly attemptId: number
    readonly stepId: string
    readonly role: string
    readonly outcome: string | null
    readonly status: string
    readonly commit: string | null
  }[]
  readonly ci: { readonly commit: string; readonly state: string } | null
}
export interface ModelDecision {
  readonly model: string
  readonly choice: string
  readonly probabilities: Readonly<Record<string, number>>
  readonly confidence: number
  readonly usage: {
    readonly inputTokens: number
    readonly outputTokens: number
  }
}
export interface DecisionInput {
  readonly question: string
  readonly options: Readonly<Record<string, string>>
  readonly bands: { readonly act: number; readonly confirm: number }
  readonly facts: DecisionFacts
  readonly answer: ModelDecision | null
  readonly band: DecisionBand
  readonly reason: string | null
  readonly durationMs: number
}
export interface DecisionRecord extends DecisionInput {
  readonly id: number
  readonly ticketId: number
  readonly ticketNumber: number
  readonly attemptId: number
  readonly stepId: string
  readonly workflow: string
  readonly workflowVersion: string
  readonly finalOption: string | null
  readonly decidedBy: 'model' | 'owner' | null
  readonly overridden: boolean
  readonly createdAt: string
  readonly decidedAt: string | null
}
export interface DecisionStepCounts {
  readonly workflow: string
  readonly workflowVersion: string
  readonly stepId: string
  readonly total: number
  readonly ownerDecisions: number
  readonly overrides: number
}
export function decisionBand(
  confidence: number,
  bands = { act: 0.9, confirm: 0.6 },
): 'acted' | 'confirm' | 'owner' {
  decideParams.shape.bands.parse(bands)
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    throw new FactoryError('invalid', 'Confidence must be between 0 and 1')
  return confidence >= bands.act
    ? 'acted'
    : confidence >= bands.confirm
      ? 'confirm'
      : 'owner'
}
