import { useQuery } from '@tanstack/react-query'
import { decisionsQuery } from '../queries.ts'
import { ErrorMessage } from '../components/Shared.tsx'
import { DecisionDetails } from '../components/Decision.tsx'

export function DecisionsPage() {
  const query = useQuery(decisionsQuery)
  if (query.isPending) return <p className="muted">Loading decisions…</p>
  if (query.isError) return <ErrorMessage error={query.error} />
  const { decisions, steps } = query.data
  const pending = decisions.filter((d) => d.pending)
  const finished = decisions.filter((d) => !d.pending)
  const row = (d: (typeof decisions)[number]) => (
    <li className="attempt-entry" key={d.id}>
      <a href={`#/tickets/${d.ticketNumber}`}>
        #{d.ticketNumber} · {d.workflow} / {d.stepId}
      </a>
      <DecisionDetails decision={d} />
    </li>
  )
  return (
    <article>
      <header className="page-heading">
        <div>
          <h1>Decisions</h1>
          <p className="muted">
            Recent decisions, with owner overrides to help tune confidence
            bands.
          </p>
        </div>
      </header>
      <section>
        <h2>Needs you</h2>
        {pending.length ? (
          <ol className="timeline">{pending.map(row)}</ol>
        ) : (
          <p className="muted">
            No pending decisions in the latest 100 outcomes.
          </p>
        )}
      </section>
      <section>
        <h2>Overrides by workflow step</h2>
        {steps.length ? (
          <div className="decision-table">
            <table>
              <thead>
                <tr>
                  <th>Workflow / step</th>
                  <th>Decisions</th>
                  <th>Owner decisions</th>
                  <th>Overrides</th>
                </tr>
              </thead>
              <tbody>
                {steps.map((s) => (
                  <tr key={`${s.workflowVersion}/${s.stepId}`}>
                    <td>
                      {s.workflow} / {s.stepId}
                      <small className="muted">
                        {' '}
                        · {s.workflowVersion.slice(0, 8)}
                      </small>
                    </td>
                    <td>{s.total}</td>
                    <td>{s.ownerDecisions}</td>
                    <td>{s.overrides}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No decisions yet.</p>
        )}
      </section>
      <section>
        <h2>Recent decisions</h2>
        <p className="muted">
          Latest 100 outcomes; counts above include the full history.
        </p>
        <ol className="timeline">{finished.map(row)}</ol>
      </section>
    </article>
  )
}
