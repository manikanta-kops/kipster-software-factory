import { inspectChecks, type Checks } from './checks.ts'
import { inspectFeedback, type PullRequestFeedback } from './feedback.ts'
import { run } from '../executors/process.ts'

export interface PullRequest {
  headRefOid?: string
  baseRefOid?: string
  baseRefName?: string
  isDraft?: boolean
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  behind?: number
  mergeCommit?: { oid: string } | null
  mergedAt?: string | null
  url: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
}
export interface GitHub {
  merge(
    repository: string,
    url: string,
    head: string,
    signal: AbortSignal,
  ): Promise<void>
  commitChecks(
    repository: string,
    branch: string,
    commit: string,
    signal: AbortSignal,
  ): Promise<Checks>
  checks(
    repository: string,
    url: string,
    head: string,
    signal: AbortSignal,
  ): Promise<Checks>
  feedback(
    repository: string,
    url: string,
    signal: AbortSignal,
  ): Promise<PullRequestFeedback[]>
  maintain(input: {
    repository: string
    branch: string
    base: string
    title: string
    body: string
    cwd: string
    signal: AbortSignal
  }): Promise<PullRequest>
  inspect(
    repository: string,
    url: string,
    signal: AbortSignal,
  ): Promise<PullRequest>
}
export function createGitHub(command: typeof run = run): GitHub {
  return {
    async merge(repository, url, head, signal) {
      await command(
        'gh',
        [
          'pr',
          'merge',
          url,
          '--repo',
          repository,
          '--squash',
          '--match-head-commit',
          head,
        ],
        { signal },
      )
    },
    commitChecks: (repository, branch, commit, signal) =>
      inspectChecks(command, repository, '', commit, signal, branch),
    checks: (repository, url, head, signal) =>
      inspectChecks(command, repository, url, head, signal),
    feedback: (repository, url, signal) =>
      inspectFeedback(command, repository, url, signal),
    async maintain({ repository, branch, base, title, body, cwd, signal }) {
      const prs = JSON.parse(
        await command(
          'gh',
          [
            'pr',
            'list',
            '--repo',
            repository,
            '--head',
            branch,
            '--state',
            'all',
            '--json',
            'url,state,headRepositoryOwner',
          ],
          { cwd, signal },
        ),
      ) as (PullRequest & { headRepositoryOwner: { login: string } })[]
      const matching = prs.filter(
        (pr) =>
          pr.headRepositoryOwner.login.toLowerCase() ===
          repository.split('/')[0]?.toLowerCase(),
      )
      const existing = matching.find((pr) => pr.state === 'OPEN')
      if (existing) {
        await command(
          'gh',
          [
            'pr',
            'edit',
            existing.url,
            '--repo',
            repository,
            '--title',
            title,
            '--body-file',
            '-',
          ],
          { cwd, signal, input: body },
        )
        return existing
      }
      const url = await command(
        'gh',
        [
          'pr',
          'create',
          '--repo',
          repository,
          '--head',
          branch,
          '--base',
          base,
          '--title',
          title,
          '--body-file',
          '-',
        ],
        { cwd, signal, input: body },
      )
      return { url, state: 'OPEN' }
    },
    async inspect(repository, url, signal) {
      const pr = JSON.parse(
        await command(
          'gh',
          [
            'pr',
            'view',
            url,
            '--repo',
            repository,
            '--json',
            'url,state,headRefOid,baseRefOid,baseRefName,isDraft,mergeable,mergeCommit,mergedAt',
          ],
          { signal },
        ),
      ) as PullRequest
      if (pr.baseRefName) {
        pr.baseRefOid = await command(
          'gh',
          [
            'api',
            `repos/${repository}/git/ref/heads/${encodeURIComponent(pr.baseRefName)}`,
            '--jq',
            '.object.sha',
          ],
          { signal },
        )
      }
      if (pr.baseRefOid && pr.headRefOid) {
        const comparison = JSON.parse(
          await command(
            'gh',
            [
              'api',
              `repos/${repository}/compare/${pr.headRefOid}...${pr.baseRefOid}`,
            ],
            { signal },
          ),
        ) as { ahead_by: number }
        pr.behind = comparison.ahead_by
      }
      return pr
    },
  }
}
export const github = createGitHub()
