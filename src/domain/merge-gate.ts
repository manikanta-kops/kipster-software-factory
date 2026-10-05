export interface VerdictFact {
  status: string
  outcome: string | null
  commit: string | null
}
export interface CheckFact {
  name: string
  state: 'pending' | 'passed' | 'failed'
  required: boolean
  url: string
}
export interface MergeFacts {
  observationError?: string | null
  baseBranchMatches?: boolean
  head: string
  localHead: string
  base: string
  behind: number
  tester: VerdictFact | null
  hasTester: boolean
  reproducer: VerdictFact | null
  hasReproducer: boolean
  ci: 'pending' | 'passed' | 'failed' | 'none' | 'head-changed'
  checks: readonly CheckFact[]
  feedback: readonly string[]
  buildWork: boolean
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  draft: boolean | null
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  paths: readonly string[]
  migrationGlobs: readonly string[]
  trustedKitError: string | null
  approvedUnverified: readonly string[] | null
}
export interface PathMatch {
  path: string
  rule: 'kit' | 'ci' | 'migration'
}
export interface MergeGate {
  ready: boolean
  blockers: readonly string[]
  needsOwner: readonly string[]
  paths: readonly PathMatch[]
  facts: MergeFacts
  evaluatedAt: string
}

const ciGlobs = [
  '.github/workflows/**',
  '.github/actions/**',
  '.circleci/**',
  '.buildkite/**',
  '.gitlab-ci*.yml',
  '.gitlab-ci*.yaml',
  '.travis.yml',
  'Jenkinsfile',
  '**/Jenkinsfile',
  'azure-pipelines*.yml',
  'azure-pipelines*.yaml',
  'bitbucket-pipelines.yml',
  'appveyor.yml',
  '.drone.yml',
  '.woodpecker/**',
  '.woodpecker.yml',
]
const migrationGlobs = [
  '**/migrations/**',
  '**/migration/**',
  '**/db/migrate/**',
  '**/schema/migrations/**',
  '**/prisma/migrations/**',
  '**/supabase/migrations/**',
  '**/alembic/versions/**',
  '**/flyway/**',
  '**/liquibase/**',
]
/** Repository-relative, case-sensitive globs: *, ** and ?; no negation or brace expansion. */
export function matchesPath(path: string, glob: string): boolean {
  let pattern = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!
    if (char === '*' && glob[i + 1] === '*') {
      i++
      if (glob[i + 1] === '/') {
        i++
        pattern += '(?:.*/)?'
      } else pattern += '.*'
    } else if (char === '*') pattern += '[^/]*'
    else if (char === '?') pattern += '[^/]'
    else pattern += char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
  }
  return new RegExp(`^${pattern}$`).test(path)
}
export function matchOwnerPaths(
  paths: readonly string[],
  extra: readonly string[] = [],
): PathMatch[] {
  return [...new Set(paths)].sort().flatMap((path) => {
    const rule = matchesPath(path, '.kipster/**')
      ? 'kit'
      : ciGlobs.some((g) => matchesPath(path, g))
        ? 'ci'
        : [...migrationGlobs, ...extra].some((g) => matchesPath(path, g))
          ? 'migration'
          : null
    return rule ? [{ path, rule }] : []
  })
}
export function evaluateMergeGate(
  facts: MergeFacts,
  evaluatedAt: string,
): MergeGate {
  const blockers: string[] = []
  if (facts.observationError) blockers.push('Live gate facts are unavailable')
  if (facts.baseBranchMatches === false)
    blockers.push('PR targets a different base branch')
  const needsOwner: string[] = []
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(facts.head))
    blockers.push('PR head is unknown')
  if (!Number.isSafeInteger(facts.behind) || facts.behind < 0)
    blockers.push('Base ancestry is unknown')
  const current = (v: VerdictFact | null, outcome: string) =>
    v?.status === 'finished' && v.outcome === outcome && v.commit === facts.head
  if (!facts.hasTester) {
    blockers.push('Untested workflow')
    needsOwner.push('Untested workflow')
  } else if (!current(facts.tester, 'passed'))
    blockers.push('Tester verdict is not passing at the current head')
  if (facts.hasReproducer && !current(facts.reproducer, 'reproduced'))
    blockers.push('Reproduction is not confirmed at the current head')
  if (facts.localHead !== facts.head)
    blockers.push('Ticket branch differs from the PR head')
  if (facts.behind > 0)
    blockers.push(
      `Behind base by ${facts.behind} commit${facts.behind === 1 ? '' : 's'}`,
    )
  if (!['passed', 'none'].includes(facts.ci)) blockers.push(`CI ${facts.ci}`)
  if (facts.feedback.length)
    blockers.push('Open owner feedback or change request')
  if (facts.buildWork) blockers.push('Build work is queued or running')
  if (facts.state !== 'OPEN')
    blockers.push(`PR is ${facts.state.toLowerCase()}`)
  if (facts.draft !== false)
    blockers.push(facts.draft ? 'PR is a draft' : 'PR draft state is unknown')
  if (facts.mergeable !== 'MERGEABLE')
    blockers.push(
      facts.mergeable === 'CONFLICTING'
        ? 'PR has conflicts'
        : 'GitHub mergeability is unknown',
    )
  const paths = matchOwnerPaths(facts.paths, facts.migrationGlobs)
  if (paths.length)
    needsOwner.push(`Touches ${paths.map((p) => p.path).join(', ')}`)
  if (facts.trustedKitError) {
    blockers.push('Trusted kit is invalid')
    needsOwner.push('Inspect the trusted kit rules')
  }
  if (facts.approvedUnverified?.length)
    needsOwner.push('Owner-approved unverified scenarios')
  return {
    ready: blockers.length === 0,
    blockers,
    needsOwner,
    paths,
    facts,
    evaluatedAt,
  }
}

export interface GateSnapshot {
  latest: MergeGate
  lastGreen: MergeGate | null
}
