import type { CheckFact } from '../domain/merge-gate.ts'
import { run } from '../executors/process.ts'

export interface Checks {
  checks?: CheckFact[]
  state: 'pending' | 'passed' | 'failed' | 'none' | 'head-changed'
  failures: { name: string; url: string; excerpt: string }[]
}
interface Check {
  kind: 'CheckRun' | 'StatusContext'
  name?: string
  context?: string
  isRequired: boolean
  status?: string
  conclusion?: string
  state?: string
  detailsUrl?: string
  targetUrl?: string
  databaseId?: number
  summary?: string
  text?: string
  description?: string
}
const query = `query($owner:String!, $name:String!, $number:Int!, $sha:GitObjectID!, $cursor:String) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) { headRefOid baseRefName baseRef { branchProtectionRule { requiredStatusCheckContexts } } }
    object(oid:$sha) { ... on Commit { statusCheckRollup { contexts(first:100, after:$cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        kind: __typename
        ... on CheckRun { name isRequired(pullRequestNumber:$number) status conclusion detailsUrl databaseId summary text }
        ... on StatusContext { context isRequired(pullRequestNumber:$number) state targetUrl description }
      }
    } } } }
  }
}`

export async function inspectChecks(
  command: typeof run,
  repository: string,
  url: string,
  head: string,
  signal: AbortSignal,
  commitOnlyBranch?: string,
): Promise<Checks> {
  const [owner, name] = repository.split('/')
  const number = commitOnlyBranch
    ? null
    : new URL(url).pathname.split('/').at(-1)!
  const checkQuery = commitOnlyBranch
    ? query
        .replace('$number:Int!, ', '')
        .replace(/    pullRequest\(number:\$number\).*\n/, '')
        .replaceAll('isRequired(pullRequestNumber:$number) ', '')
    : query
  const checks: Check[] = []
  let cursor: string | undefined
  let required: string[] = []
  let base = ''
  do {
    const response = JSON.parse(
      await command(
        'gh',
        [
          'api',
          'graphql',
          '-f',
          `query=${checkQuery}`,
          '-f',
          `owner=${owner}`,
          '-f',
          `name=${name}`,
          ...(number ? ['-F', `number=${number}`] : []),
          '-f',
          `sha=${head}`,
          ...(cursor ? ['-f', `cursor=${cursor}`] : []),
        ],
        { signal },
      ),
    ) as {
      errors?: { message: string }[]
      data: {
        repository: {
          pullRequest: {
            headRefOid: string
            baseRefName: string
            baseRef: {
              branchProtectionRule: {
                requiredStatusCheckContexts: string[]
              } | null
            } | null
          }
          object: {
            statusCheckRollup: {
              contexts: {
                nodes: Check[]
                pageInfo: { hasNextPage: boolean; endCursor: string }
              }
            } | null
          } | null
        }
      }
    }
    if (response.errors?.length)
      throw new Error(response.errors.map((e) => e.message).join('; '))
    const repo = response.data.repository
    if (!commitOnlyBranch && repo.pullRequest.headRefOid !== head)
      return { state: 'head-changed', failures: [] }
    if (!repo.object)
      throw new Error(`GitHub cannot find pushed commit ${head}`)
    base = commitOnlyBranch ?? repo.pullRequest.baseRefName
    required =
      repo.pullRequest?.baseRef?.branchProtectionRule
        ?.requiredStatusCheckContexts ?? []
    const contexts = repo.object.statusCheckRollup?.contexts
    checks.push(...(contexts?.nodes ?? []))
    cursor = contexts?.pageInfo.hasNextPage
      ? contexts.pageInfo.endCursor
      : undefined
  } while (cursor)
  if (!commitOnlyBranch) {
    // PR requirements may never run on a default-branch commit.
    const rules = JSON.parse(
      await command(
        'gh',
        [
          'api',
          '--paginate',
          '--slurp',
          `repos/${repository}/rules/branches/${encodeURIComponent(base)}`,
        ],
        { signal },
      ),
    ) as {
      type: string
      parameters?: { required_status_checks?: { context: string }[] }
    }[][]
    required.push(
      ...rules
        .flat()
        .flatMap((r) =>
          r.type === 'required_status_checks'
            ? (r.parameters?.required_status_checks ?? []).map((c) => c.context)
            : [],
        ),
    )
  }
  const selected = checks.filter(
    (c) => c.isRequired || required.includes(c.name ?? c.context ?? ''),
  )
  // Repositories without protection still get their configured CI checked.
  const relevant = commitOnlyBranch
    ? checks
    : selected.length || required.length
      ? selected
      : checks
  const missing = required.some(
    (requiredName) =>
      !selected.some((c) => (c.name ?? c.context) === requiredName),
  )
  // Only required checks are awaited, but any completed failure goes back to the builder.
  const failed = checks.filter((c) =>
    c.kind === 'CheckRun'
      ? c.status === 'COMPLETED' &&
        !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion ?? '')
      : ['FAILURE', 'ERROR'].includes(c.state ?? ''),
  )
  const failures = []
  for (const check of failed) {
    let excerpt = [check.summary, check.text, check.description]
      .filter(Boolean)
      .join('\n')
      .slice(-2000)
    const link = check.detailsUrl ?? check.targetUrl ?? ''
    if (check.databaseId && link.includes('/actions/runs/')) {
      try {
        excerpt = (
          await command(
            'gh',
            [
              'run',
              'view',
              '--repo',
              repository,
              '--job',
              String(check.databaseId),
              '--log-failed',
            ],
            { signal },
          )
        ).slice(-2000)
      } catch (error) {
        signal.throwIfAborted()
        excerpt ||= `Log unavailable: ${String(error).slice(0, 300)}`
      }
    }
    failures.push({
      name: check.name ?? check.context ?? 'Unknown check',
      url: link,
      excerpt: excerpt || 'No log excerpt supplied by this check provider.',
    })
  }
  const pending =
    missing ||
    relevant.some((c) =>
      c.kind === 'CheckRun'
        ? c.status !== 'COMPLETED'
        : !['SUCCESS', 'FAILURE', 'ERROR'].includes(c.state ?? ''),
    )
  return {
    state: failures.length
      ? 'failed'
      : pending
        ? 'pending'
        : relevant.length
          ? 'passed'
          : 'none',
    failures,
    checks: [
      ...checks.map((c): CheckFact => ({
        name: c.name ?? c.context ?? 'Unknown check',
        required:
          !!c.isRequired || required.includes(c.name ?? c.context ?? ''),
        url: c.detailsUrl ?? c.targetUrl ?? '',
        state:
          c.kind === 'CheckRun'
            ? c.status !== 'COMPLETED'
              ? 'pending'
              : ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion ?? '')
                ? 'passed'
                : 'failed'
            : c.state === 'SUCCESS'
              ? 'passed'
              : ['FAILURE', 'ERROR'].includes(c.state ?? '')
                ? 'failed'
                : 'pending',
      })),
      ...[...new Set(required)]
        .filter(
          (requiredName) =>
            !selected.some((c) => (c.name ?? c.context) === requiredName),
        )
        .map((requiredName): CheckFact => ({
          name: requiredName,
          required: true,
          url: '',
          state: 'pending',
        })),
    ],
  }
}
