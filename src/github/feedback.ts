import type { run } from '../executors/process.ts'

export const FACTORY_MARKER = '<!-- kipster-factory -->'
export interface PullRequestFeedback {
  id: string
  url: string
  author: string
  body: string
  createdAt: string
}
interface Entry {
  id: number
  user: { login: string; type: string } | null
  body: string | null
  html_url: string
  created_at?: string
  submitted_at?: string
  state?: string
  author_association?: string
  path?: string
  line?: number
  pull_request_review_id?: number
}
export async function inspectFeedback(
  command: typeof run,
  repository: string,
  url: string,
  signal: AbortSignal,
): Promise<PullRequestFeedback[]> {
  const number = new URL(url).pathname.split('/').at(-1)!
  const viewer = await command('gh', ['api', 'user', '--jq', '.login'], {
    signal,
  })
  const owner = repository.split('/')[0]!.toLowerCase()
  const read = async (path: string): Promise<Entry[]> =>
    JSON.parse(
      await command(
        'gh',
        ['api', '--paginate', '--slurp', `repos/${repository}/${path}`],
        { signal },
      ),
    ).flat()
  const [reviews, comments, inline] = await Promise.all([
    read(`pulls/${number}/reviews`),
    read(`issues/${number}/comments`),
    read(`pulls/${number}/comments`),
  ])
  const human = (entry: Entry) =>
    entry.user &&
    entry.user.type !== 'Bot' &&
    !entry.body?.includes(FACTORY_MARKER)
  const owned = (entry: Entry) =>
    human(entry) &&
    (entry.author_association === 'OWNER' ||
      [owner, viewer.toLowerCase()].includes(entry.user!.login.toLowerCase()))
  const latestReviews = new Map<string, Entry>()
  for (const review of reviews)
    if (
      human(review) &&
      review.state !== 'PENDING' &&
      review.state !== 'COMMENTED'
    )
      latestReviews.set(review.user!.login, review)
  const requesting = [...latestReviews.values()].filter(
    (r) => r.state === 'CHANGES_REQUESTED',
  )
  const requestedReviews = new Set(requesting.map((r) => r.id))
  const convert = (entry: Entry, kind: string): PullRequestFeedback => ({
    id: `${kind}:${entry.id}`,
    url: entry.html_url,
    author: entry.user!.login,
    body: `${entry.path ? `${entry.path}${entry.line ? `:${entry.line}` : ''}\n\n` : ''}${entry.body || 'Changes requested; see the review on GitHub.'}`,
    createdAt: entry.submitted_at ?? entry.created_at!,
  })
  return [
    ...requesting.map((r) => convert(r, 'review')),
    ...reviews
      .filter((r) => r.state === 'COMMENTED' && owned(r) && r.body)
      .map((r) => convert(r, 'review')),
    ...comments.filter(owned).map((c) => convert(c, 'comment')),
    ...inline
      .filter(
        (c) =>
          owned(c) ||
          (human(c) && requestedReviews.has(c.pull_request_review_id ?? -1)),
      )
      .map((c) => convert(c, 'inline')),
  ]
}
