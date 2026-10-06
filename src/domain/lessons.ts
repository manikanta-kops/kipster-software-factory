import type { Artifact, Attempt, Ticket } from './records.ts'
import type { Workflow } from './workflow.ts'
import { findingTitle } from './review.ts'
import { failureSignature, repeatedFailures } from './tasks.ts'

export const LESSON_STATUSES = [
  'proposed',
  'accepted',
  'rejected',
  'retired',
] as const
export type LessonStatus = (typeof LESSON_STATUSES)[number]
export type LessonSource =
  'changes-needed' | 'repeated-failure' | 'owner-comment'
export interface LessonProposal {
  readonly repositoryId: number | null
  readonly text: string
  readonly source: LessonSource
  readonly sourceTicketId: number
  readonly key: string
}
export interface Lesson extends LessonProposal {
  readonly id: number
  readonly status: LessonStatus
  readonly retiredReason: string | null
  readonly createdAt: string
  readonly decidedAt: string | null
}

const line = (text: string) => text.replace(/\s+/g, ' ').trim()

/** Failure results here are recorded errors, never agent summaries. */
export function proposeLessons(facts: {
  readonly ticket: Pick<Ticket, 'id' | 'repository'>
  readonly attempts: readonly Attempt[]
  readonly artifacts: readonly Artifact[]
  readonly workflow: Workflow
  readonly failures?: readonly {
    key: string
    status: 'failed'
    result: string
  }[]
  readonly existing: readonly Lesson[]
}): LessonProposal[] {
  const proposals: LessonProposal[] = []
  function add(
    source: LessonSource,
    text: string,
    key: string,
    engine = false,
  ) {
    const repositoryId = engine ? null : facts.ticket.repository.id
    key = key.slice(0, 240)
    if (
      facts.existing.some(
        (l) => l.repositoryId === repositoryId && l.key === key,
      ) ||
      proposals.some((l) => l.repositoryId === repositoryId && l.key === key)
    )
      return
    proposals.push({
      repositoryId,
      text: line(text).slice(0, 200),
      source,
      sourceTicketId: facts.ticket.id,
      key,
    })
  }
  const findings = new Map<string, { title: string; rounds: Set<number> }>()
  for (const artifact of facts.artifacts) {
    const attempt = facts.attempts.find((a) => a.id === artifact.attemptId)
    if (!attempt || attempt.status !== 'finished') continue
    if (
      artifact.kind === 'finding' &&
      attempt.outcome === 'changes-needed' &&
      attempt.waitingFor === null &&
      facts.workflow.steps.some(
        (s) =>
          s.id === attempt.stepId &&
          s.kind === 'agent' &&
          s.role === 'reviewer',
      )
    ) {
      const title = findingTitle(line(artifact.title))
      if (!title) continue
      const key = title.toLowerCase()
      const group = findings.get(key) ?? { title, rounds: new Set<number>() }
      group.rounds.add(attempt.id)
      findings.set(key, group)
    }
    if (
      artifact.kind === 'comment' &&
      artifact.content?.trim() &&
      attempt.waitingFor === 'human' &&
      attempt.executor === 'human' &&
      ['changes-needed', 'rejected'].includes(attempt.outcome ?? '')
    ) {
      const comment = line(artifact.content)
      add(
        'owner-comment',
        `Owner correction: ${comment}`,
        `owner-comment:${comment.toLowerCase()}`,
      )
    }
  }
  for (const [key, group] of findings) {
    if (group.rounds.size >= 2)
      add(
        'changes-needed',
        `Check before review: ${group.title}`,
        `changes-needed:${key}`,
      )
  }
  for (const group of repeatedFailures(facts.failures ?? [])) {
    const errors = (facts.failures ?? []).filter(
      (f) => failureSignature(f.result) === group.signature,
    )
    const engine = errors.some((f) =>
      /(?:agent|codex|claude)(?: cli)?[^\n]*(?:crash|exited|exit code)|(?:invalid|validat\w*|parse)[^\n]*result\.json|result\.json[^\n]*(?:invalid|validat\w*|requires|missing|parse)/i.test(
        f.result,
      ),
    )
    add(
      'repeated-failure',
      `Avoid repeated failure: ${group.signature}`,
      `repeated-failure:${group.signature}`,
      engine,
    )
  }
  return proposals
}
