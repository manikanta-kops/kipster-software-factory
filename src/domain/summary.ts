import type { Artifact, Attempt, LeadTask, Ticket } from './records.ts'
import { evaluateMergeGate, type MergeGate } from './merge-gate.ts'
import { scenarioIndex } from './evidence.ts'
import { untestedReasons } from './task-testing.ts'
import type { Workflow } from './workflow.ts'

export interface TicketSummary {
  readonly status: 'ready' | 'needs-you' | 'blocked'
  readonly needsYouCount: number
  readonly actions: readonly { readonly label: string; readonly href: string }[]
  readonly happened: string
  readonly issues: readonly string[]
  readonly unverified: readonly string[]
}

/** Only structured facts enter the report; agent prose stays in the timeline. */
export function summarizeTicket(facts: {
  readonly ticket: Ticket
  readonly attempts: readonly Attempt[]
  readonly tasks: readonly LeadTask[]
  readonly artifacts: readonly Artifact[]
  readonly workflow: Workflow
  readonly mergeGate: MergeGate | null
}): TicketSummary {
  const {
    ticket,
    attempts,
    tasks,
    artifacts,
    workflow,
    mergeGate: snapshot,
  } = facts
  const observed = attempts.findLast((a) => a.headCommit)
  const gate = snapshot
    ? evaluateMergeGate(
        {
          ...snapshot.facts,
          buildWork: attempts.some((a) =>
            ['pending', 'running'].includes(a.status),
          ),
          localHead:
            observed &&
            Date.parse(
              observed.finishedAt ?? observed.startedAt ?? observed.createdAt,
            ) > Date.parse(snapshot.evaluatedAt)
              ? observed.headCommit!
              : snapshot.facts.localHead,
        },
        snapshot.evaluatedAt,
      )
    : null
  const href = `#/tickets/${ticket.number}`
  const actions: { label: string; href: string }[] = []
  const issues: string[] = []
  const unverified = untestedReasons(facts)
  const waiting = ticket.waiting
  const brokenAsk =
    waiting?.for === 'ask' &&
    ['failed', 'limit', 'interrupted', 'unrouted'].includes(
      waiting.askReason ?? '',
    )
  if (ticket.status === 'cancelled') issues.push('Ticket cancelled')
  if (brokenAsk) {
    issues.push(`Stopped at ${waiting.stepId}: ${waiting.askReason}`)
    actions.push({ label: 'Resolve stopped step', href })
  } else if (waiting?.for === 'human') {
    actions.push({ label: `Review ${waiting.stepId}`, href })
  } else if (waiting?.for === 'ask' || waiting?.for === 'decision') {
    actions.push({ label: 'Answer decision', href })
  }
  for (const task of tasks) {
    const childHref = task.child ? `#/tickets/${task.child.number}` : href
    if (task.status === 'parked')
      actions.push({ label: `Answer task ${task.key}`, href: childHref })
    if (task.status === 'left-open')
      actions.push({
        label: `Merge task ${task.key}`,
        href: task.child?.pullRequestUrl ?? childHref,
      })
    if (['failed', 'conflict', 'cancelled'].includes(task.status))
      issues.push(`Task ${task.key}: ${task.status}`)
  }
  const roles = new Map(
    workflow.steps.filter((s) => s.kind === 'agent').map((s) => [s.id, s.role]),
  )
  for (const role of ['tester', 'reviewer']) {
    const verdict = attempts.findLast(
      (a) => roles.get(a.stepId) === role && a.waitingFor === null,
    )
    if (
      verdict &&
      (verdict.status === 'failed' ||
        verdict.status === 'interrupted' ||
        (verdict.status === 'finished' && verdict.outcome !== 'passed'))
    )
      issues.push(
        `${role === 'tester' ? 'Tester' : 'Reviewer'} ${verdict.stepId}: ${verdict.outcome ?? verdict.status}`,
      )
  }
  const ownerReview = attempts.findLast(
    (a) => roles.get(a.stepId) === 'reviewer' && a.waitingFor === null,
  )?.ownerReview
  if (ownerReview || gate?.facts.reviewer?.ownerReview) {
    issues.push('Reviewer flagged owner review')
    if (ticket.status !== 'done')
      actions.push({ label: 'Review flagged change', href })
  }
  const head =
    gate?.facts.localHead ??
    attempts.findLast((a) => a.headCommit)?.headCommit ??
    null
  const scenarios = scenarioIndex(artifacts, attempts, roles, head)
  const unproven = scenarios.filter(
    (s) => !s.current || !['passed', 'reproduced'].includes(s.result),
  ).length
  if (unproven)
    unverified.push(
      `${unproven} scenario${unproven === 1 ? '' : 's'} unverified at the current commit`,
    )
  // A completed ticket retains historical gate facts, including an OPEN PR snapshot.
  if (ticket.status !== 'done' && gate) issues.push(...gate.blockers)
  if (waiting?.for === 'pull-request-merge') {
    if (!gate) unverified.push('Merge gate has not been evaluated')
    if (gate && !gate.facts.hasTester && !ticket.skippedSteps?.length)
      unverified.push('Untested workflow')
    if (gate && !gate.facts.hasReviewer) unverified.push('Unreviewed workflow')
    if (gate?.facts.approvedUnverified?.length)
      unverified.push(
        `${gate.facts.approvedUnverified.length} owner-approved unverified scenarios`,
      )
    if (
      gate?.paths.length ||
      gate?.facts.approvedUnverified?.length ||
      gate?.facts.trustedKitError
    )
      actions.push({ label: 'Review merge requirements', href })
    if (ticket.pullRequestUrl)
      actions.push({
        label: gate?.ready ? 'Merge pull request' : 'Review pull request',
        href: ticket.pullRequestUrl,
      })
  }
  const executions = attempts.filter(
    (a) =>
      a.waitingFor !== 'ask' &&
      a.waitingFor !== 'human' &&
      (a.startedAt !== null ||
        ['finished', 'failed', 'interrupted'].includes(a.status)),
  )
  const retries =
    executions.length - new Set(executions.map((a) => a.stepId)).size
  const parts: string[] = []
  if (tasks.length) {
    const merged = tasks.filter((t) => t.status === 'merged').length
    parts.push(`${merged} task${merged === 1 ? '' : 's'} merged`)
    for (const status of [
      'failed',
      'conflict',
      'parked',
      'left-open',
      'cancelled',
    ] as const) {
      const count = tasks.filter((t) => t.status === status).length
      if (count) parts.push(`${count} ${status}`)
    }
  } else {
    const completed = attempts.filter(
      (a) => a.status === 'finished' && a.waitingFor !== 'ask',
    ).length
    parts.push(`${completed} step${completed === 1 ? '' : 's'} completed`)
  }
  if (retries) parts.push(`${retries} retr${retries === 1 ? 'y' : 'ies'}`)
  const decisions = artifacts.filter(
    (a) => a.kind === 'decision' && a.decision,
  ).length
  if (decisions)
    parts.push(`${decisions} decision${decisions === 1 ? '' : 's'} recorded`)
  const start =
    attempts[0]?.startedAt ?? attempts[0]?.createdAt ?? ticket.createdAt
  const end = waiting?.since ?? attempts.at(-1)?.finishedAt ?? ticket.updatedAt
  const minutes = Math.max(
    0,
    Math.floor((Date.parse(end) - Date.parse(start)) / 60000),
  )
  parts.push(
    minutes >= 60
      ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
      : `${minutes}m`,
  )
  const blocked =
    ticket.status === 'cancelled' ||
    brokenAsk ||
    tasks.some((t) => t.status === 'failed' || t.status === 'conflict') ||
    (ticket.status !== 'done' && !!gate?.blockers.length)
  const onlyMerge =
    waiting?.for === 'pull-request-merge' &&
    gate?.ready &&
    !unverified.length &&
    actions.length === 1 &&
    !!ticket.pullRequestUrl &&
    tasks.every((t) => ['merged', 'cancelled'].includes(t.status))
  const status = blocked
    ? 'blocked'
    : (ticket.status === 'done' && !actions.length) || onlyMerge
      ? 'ready'
      : 'needs-you'
  return {
    status,
    needsYouCount: actions.length,
    actions,
    happened: parts.join(' · '),
    issues: [...new Set(issues)],
    unverified: [...new Set(unverified)],
  }
}
