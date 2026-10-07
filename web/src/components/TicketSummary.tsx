import type { TicketSummary } from '../../../src/api/contract.ts'

export function SummaryStatus({ summary }: { summary: TicketSummary }) {
  return (
    <span className={`summary-status ${summary.status}`}>
      {summary.status === 'ready'
        ? 'Ready'
        : summary.status === 'blocked'
          ? 'Blocked'
          : `Needs you · ${summary.needsYouCount}`}
    </span>
  )
}

export function TicketSummaryCard({ summary }: { summary: TicketSummary }) {
  return (
    <section className="ticket-summary" aria-label="Ticket summary">
      <div className="summary-top">
        <SummaryStatus summary={summary} />
        <button
          className="text-link"
          onClick={() => {
            const details = document.getElementById('ticket-details')
            details?.scrollIntoView({ block: 'start' })
            details?.focus({ preventScroll: true })
          }}
        >
          View details
        </button>
      </div>
      <p className="summary-happened">{summary.happened}</p>
      {summary.actions.length > 0 && (
        <ul className="summary-actions">
          {summary.actions.map((action, i) => (
            <li key={i}>
              <a className="text-link" href={action.href}>
                {action.label}
              </a>
            </li>
          ))}
        </ul>
      )}
      {summary.issues.length > 0 && (
        <ul className="summary-issues" aria-label="Issues">
          {summary.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      {summary.unverified.length > 0 && (
        <ul className="summary-unverified" aria-label="Unverified">
          {summary.unverified.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </section>
  )
}
