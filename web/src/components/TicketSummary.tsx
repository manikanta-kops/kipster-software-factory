import type { TicketSummary } from '../../../src/api/contract.ts'

export function SummaryStatus({
  summary,
}: {
  summary: Pick<TicketSummary, 'status' | 'needsYouCount'>
}) {
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

/** A task the lead retried reads as replaced, never as blocked. */
export function ReplacedBy({ number }: { number: number }) {
  return (
    <a className="summary-status replaced" href={`#/tickets/${number}`}>
      Replaced by #{number}
    </a>
  )
}

export function TicketSummaryCard({
  summary,
  replacedBy,
}: {
  summary: TicketSummary
  replacedBy?: number | null | undefined
}) {
  return (
    <section className="ticket-summary" aria-label="Ticket summary">
      <div className="summary-top">
        {replacedBy ? (
          <ReplacedBy number={replacedBy} />
        ) : (
          <SummaryStatus summary={summary} />
        )}
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
