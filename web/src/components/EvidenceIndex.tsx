import type { TicketResponse } from '../../../src/api/contract.ts'
import { ArtifactView } from './ArtifactView.tsx'
export function EvidenceIndex({
  detail,
  selected,
}: {
  detail: TicketResponse
  selected?: number
}) {
  const item =
    selected === undefined
      ? undefined
      : detail.artifacts.find((a) => a.id === selected)
  if (selected !== undefined)
    return (
      <section className="evidence-card" aria-label="Evidence item">
        <a href={`#/tickets/${detail.ticket.number}`}>
          ‹ Back to ticket #{detail.ticket.number}
        </a>
        {item ? (
          <>
            <h2>{item.title}</h2>
            <ArtifactView key={item.id} artifact={item} defaultOpen />
          </>
        ) : (
          <p role="alert">Evidence item not found on this ticket.</p>
        )}
      </section>
    )
  const scenarios = detail.evidenceIndex ?? []
  if (!detail.artifacts.some((a) => a.kind === 'evidence')) return null
  return (
    <section className="evidence-card" aria-label="Scenario evidence">
      <h2 className="section-title">Scenario evidence</h2>
      {!scenarios.length && (
        <p className="muted">
          No scenario labels recorded. Evidence is in the archive.
        </p>
      )}
      {scenarios.map((scenario) => {
        const artifact = detail.artifacts.find(
          (a) => a.id === scenario.artifactId,
        )!
        return (
          <article
            className="scenario-evidence"
            key={`${scenario.role}:${scenario.scenario}`}
          >
            <h3>{scenario.scenario}</h3>
            <p>
              {scenario.role}: {scenario.result} · Commit{' '}
              <code>{scenario.commit?.slice(0, 7) ?? 'unknown'}</code>
              {scenario.current ? ' · current' : ' · earlier commit'}
            </p>
            <a
              className="text-link"
              href={`#/tickets/${detail.ticket.number}/evidence/${artifact.id}`}
            >
              Open evidence item
            </a>
            {scenario.current ? (
              <ArtifactView artifact={artifact} defaultOpen />
            ) : (
              <p className="muted">Earlier evidence is in the archive.</p>
            )}
          </article>
        )
      })}
    </section>
  )
}
