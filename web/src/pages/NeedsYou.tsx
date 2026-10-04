import { useQuery } from '@tanstack/react-query'
import type { Ticket } from '../../../src/api/contract.ts'
import {
  attention,
  ErrorMessage,
  PullRequest,
  Status,
} from '../components/Shared.tsx'
import { ticketsQuery } from '../queries.ts'

export function NeedsYou() {
  const query = useQuery(ticketsQuery)
  if (query.isPending) return <p className="muted">Loading tickets…</p>
  if (query.isError) return <ErrorMessage error={query.error} />
  const needsYou = query.data.tickets.filter(
    (ticket) => ticket.status === 'needs-you',
  )
  const active = query.data.tickets.filter((ticket) =>
    ['queued', 'running'].includes(ticket.status),
  )
  const finished = query.data.tickets.filter((ticket) =>
    ['done', 'cancelled'].includes(ticket.status),
  )
  return (
    <div className="home-page">
      <header className="page-heading">
        <div>
          <h1>{needsYou.length ? 'Needs you' : 'Nothing needs you.'}</h1>
          <p className="muted">
            {needsYou.length
              ? 'A few decisions to keep things moving.'
              : 'When a ticket needs a decision, it appears here.'}
          </p>
        </div>
        <a className="button primary" href="#/tickets/new">
          New ticket
        </a>
      </header>
      <div className="attention-cards">
        {needsYou.map((ticket) => (
          <article className="attention-card" key={ticket.id}>
            <p className="attention-label">{attention(ticket)}</p>
            <h2>
              <a href={`#/tickets/${ticket.number}`}>
                <span className="muted">#{ticket.number}</span> {ticket.title}
              </a>
            </h2>
            <p className="muted">
              {ticket.repository.slug} · {ticket.waiting?.stepId}
            </p>
            {ticket.waiting?.summary && <p>{ticket.waiting.summary}</p>}
            <div className="card-links">
              <a className="text-link" href={`#/tickets/${ticket.number}`}>
                Open ticket
              </a>
              <PullRequest
                url={
                  ticket.waiting?.for === 'pull-request-merge'
                    ? ticket.pullRequestUrl
                    : null
                }
              />
            </div>
          </article>
        ))}
      </div>
      <section className="progress-section">
        <h2>
          In progress <span className="muted">{active.length}</span>
        </h2>
        {active.length ? (
          <TicketList tickets={active} />
        ) : (
          <p className="muted">No tickets in progress.</p>
        )}
      </section>
      {finished.length > 0 && (
        <details className="finished">
          <summary>Show finished ({finished.length})</summary>
          <TicketList tickets={finished} />
        </details>
      )}
    </div>
  )
}
function TicketList({ tickets }: { tickets: Ticket[] }) {
  return (
    <ul className="ticket-list">
      {tickets.map((ticket) => (
        <li key={ticket.id}>
          <a href={`#/tickets/${ticket.number}`}>
            <span className="ticket-list-title">
              <span className="muted">#{ticket.number}</span> {ticket.title}
              <small>
                {ticket.repository.slug} · {ticket.currentStep}
              </small>
            </span>
            <Status value={ticket.status} />
          </a>
        </li>
      ))}
    </ul>
  )
}
