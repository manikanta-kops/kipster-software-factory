import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Ticket, TicketAskReason } from '../../../src/api/contract.ts'

export function ErrorMessage({ error }: { error: Error | null }) {
  return error ? (
    <p className="error" role="alert">
      {error.message}
    </p>
  ) : null
}
const markdownComponents = {
  img: ({ alt }: { alt?: string | undefined }) => <span>{alt}</span>,
}

export function MarkdownBody({ children }: { children: string }) {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={markdownComponents}
      >
        {children}
      </Markdown>
    </div>
  )
}
export const askReasons: Record<TicketAskReason, string> = {
  'needs-decision': 'This step needs a decision.',
  routed: 'This outcome needs your input.',
  unrouted: 'This outcome has no route.',
  limit: 'A loop reached its limit.',
  failed: 'This step failed.',
  interrupted: 'This step was interrupted twice.',
}
export function attention(ticket: Ticket) {
  const waiting = ticket.waiting
  if (waiting?.for === 'pull-request-merge') return 'Merge the pull request'
  if (waiting?.for === 'decision')
    return `Choose an option at ${waiting.stepId}`
  if (waiting?.for === 'human')
    return waiting.stepId.includes('plan')
      ? 'Review and approve the plan'
      : `Decide at ${waiting.stepId}`
  return waiting?.askReason
    ? askReasons[waiting.askReason]
    : 'Your input is needed'
}
export function Status({ value }: { value: string }) {
  return <span className={`badge ${value}`}>{value.replaceAll('-', ' ')}</span>
}
export function PullRequest({ url }: { url: string | null }) {
  if (!url || !/^https?:\/\//i.test(url)) return null
  return (
    <a className="text-link" href={url} target="_blank" rel="noreferrer">
      Open pull request ↗
    </a>
  )
}
