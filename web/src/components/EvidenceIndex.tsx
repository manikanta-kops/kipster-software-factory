import type { TicketResponse } from '../../../src/api/contract.ts'
import { useState } from 'react'
import { ArtifactView } from './ArtifactView.tsx'
import { Icon } from './Icon.tsx'
import { IMAGE_TYPES, ImageViewer, MediaThumb } from './Media.tsx'
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
  return <ScenarioChecklist detail={detail} />
}

function ScenarioChecklist({ detail }: { detail: TicketResponse }) {
  const [viewing, setViewing] = useState<number | null>(null)
  const scenarios = (detail.evidenceIndex ?? []).map((scenario) => ({
    scenario,
    artifact: detail.artifacts.find((a) => a.id === scenario.artifactId)!,
  }))
  if (!scenarios.length) return null
  const images = scenarios
    .filter(
      ({ scenario, artifact }) =>
        scenario.current &&
        !artifact.prunedAt &&
        IMAGE_TYPES.has(artifact.mediaType),
    )
    .map(({ artifact }) => artifact)
  const passed = scenarios.filter(
    ({ scenario }) => scenario.result === 'passed',
  ).length
  return (
    <section className="evidence-card" aria-label="Scenario evidence">
      <h2 className="section-title">
        Scenario evidence
        <span className="steps-progress">
          {passed} of {scenarios.length} passed
        </span>
      </h2>
      <ul className="scenario-list">
        {scenarios.map(({ scenario, artifact }) => {
          const image = images.includes(artifact)
          const title = artifact.title.startsWith(`${scenario.scenario}:`)
            ? artifact.title.slice(scenario.scenario.length + 1).trim()
            : artifact.title
          return (
            <li
              className={`scenario-row ${scenario.result}`}
              key={`${scenario.role}:${scenario.scenario}`}
            >
              <span className="scenario-mark" aria-hidden="true">
                <Icon
                  name={scenario.result === 'passed' ? 'check' : 'x'}
                  size={11}
                  stroke={2.6}
                />
              </span>
              <div className="scenario-main">
                <h3>
                  <span className="scenario-key">{scenario.scenario}</span>
                  {title !== scenario.scenario && (
                    <span className="scenario-title">{title}</span>
                  )}
                </h3>
                <p className="scenario-meta">
                  {scenario.role}: {scenario.result} · Commit{' '}
                  <code>{scenario.commit?.slice(0, 7) ?? 'unknown'}</code>
                  {scenario.current ? ' · current' : ' · earlier commit'}{' '}
                  <a
                    className="text-link"
                    href={`#/tickets/${detail.ticket.number}/evidence/${artifact.id}`}
                  >
                    Open evidence item
                  </a>
                </p>
                {!scenario.current ? (
                  <p className="muted">Earlier evidence is in the archive.</p>
                ) : (
                  !image && <ArtifactView artifact={artifact} />
                )}
              </div>
              {image && (
                <MediaThumb
                  artifact={artifact}
                  onOpen={() => setViewing(images.indexOf(artifact))}
                />
              )}
            </li>
          )
        })}
      </ul>
      {viewing !== null && images[viewing] && (
        <ImageViewer
          images={images}
          index={viewing}
          onIndex={setViewing}
          onClose={() => setViewing(null)}
        />
      )}
    </section>
  )
}
