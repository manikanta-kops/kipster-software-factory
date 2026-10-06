import type { StepSummary, Ticket } from '../../src/api/contract.ts'

/** `owner/name` → `name`. */
export function repositoryName(slug: string) {
  return slug.split('/')[1] ?? slug
}

/** `approve-plan` → `Approve plan`. */
export function humanize(id: string) {
  const words = id.replaceAll('-', ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const ACTION_NAMES: Record<string, string> = {
  'maintain-pr': 'Pull request',
  'verify-kit': 'Verify kit',
  'run-tasks': 'Run tasks',
}

/** A step's name for people; system steps named after their action read as the action. */
export function stepName(step: Pick<StepSummary, 'id' | 'kind' | 'does'>) {
  if (step.kind === 'system' && step.id === step.does)
    return ACTION_NAMES[step.id] ?? humanize(step.id)
  return humanize(step.id)
}

const VERBS: Record<string, string> = {
  planner: 'Planning',
  builder: 'Building',
  tester: 'Testing',
  reproducer: 'Reproducing',
  reviewer: 'Reviewing',
  writer: 'Writing',
  onboarder: 'Writing the kit',
  lead: 'Leading',
  'verify-kit': 'Verifying the kit',
  'maintain-pr': 'Updating the pull request',
  merge: 'Ready to merge',
  decide: 'Deciding',
  'run-tasks': 'Running tasks',
}

/** What a ticket is doing now, in a word or two. */
export function doing(ticket: Ticket, step: StepSummary | undefined) {
  if (ticket.status === 'queued') return 'Queued'
  if (ticket.status === 'done') return 'Done'
  if (ticket.status === 'cancelled') return 'Cancelled'
  if (ticket.waiting?.for === 'pull-request-checks') return 'Waiting for CI'
  if (ticket.waiting?.for === 'other-repo') return 'Waiting for linked ticket'
  if (ticket.waiting?.for === 'tasks') return 'Waiting for tasks'
  if (ticket.status === 'needs-you') return 'Waiting for you'
  if (!step) return humanize(ticket.currentStep)
  if (step.kind === 'human') return 'Waiting for you'
  return VERBS[step.does ?? ''] ?? humanize(step.id)
}

/** Muted tones that label a repository without shouting: light, then dark. */
const TONES: readonly (readonly [string, string])[] = [
  ['#4f9473', '#7cc49e'],
  ['#6267cf', '#9ca2ff'],
  ['#cf7646', '#f2a77a'],
  ['#c25f86', '#ef92b6'],
  ['#a8822a', '#e2bd5a'],
  ['#3584bb', '#71b9e8'],
  ['#9063bd', '#c39ce8'],
  ['#2a8f8f', '#62caca'],
]

/** A stable tone per repository, as CSS custom properties. Ids keep the first eight distinct. */
export function repositoryTone(id: number): Record<string, string> {
  const [light, dark] = TONES[Math.abs(id - 1) % TONES.length]!
  return { '--tone-light': light, '--tone-dark': dark }
}

export function since(iso: string, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours === 1 ? '1 hour' : `${hours} hours`
  const days = Math.floor(hours / 24)
  return days === 1 ? '1 day' : `${days} days`
}

export function greeting(now = new Date()) {
  const hour = now.getHours()
  return hour < 5
    ? 'Good night'
    : hour < 12
      ? 'Good morning'
      : hour < 18
        ? 'Good afternoon'
        : 'Good evening'
}

/** `{ cli: 'claude', model: 'opus', effort: 'high' }` → `claude · opus · high`. */
export function agentLabel(agent: {
  readonly cli: string
  readonly model?: string | undefined
  readonly effort?: string | undefined
}) {
  return [agent.cli, agent.model, agent.effort].filter(Boolean).join(' · ')
}
