import { inspectChecks, type Checks } from './checks.ts'
import { inspectFeedback, type PullRequestFeedback } from './feedback.ts'
import { run } from '../executors/process.ts'

export interface PullRequest {
  url: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
}
export interface GitHub {
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
      const existing = matching.find((pr) => pr.state === 'OPEN') ?? matching[0]
      if (existing) {
        if (existing.state === 'OPEN')
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
      return JSON.parse(
        await command(
          'gh',
          ['pr', 'view', url, '--repo', repository, '--json', 'url,state'],
          { signal },
        ),
      ) as PullRequest
    },
  }
}
export const github = createGitHub()
