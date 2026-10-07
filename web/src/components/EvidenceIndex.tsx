import type { Artifact, TicketResponse } from '../../../src/api/contract.ts'
import type { ScenarioEvidence } from '../../../src/domain/evidence.ts'
import { useId, useState } from 'react'
import { ArtifactView } from './ArtifactView.tsx'
import { Icon } from './Icon.tsx'
import {
  IMAGE_TYPES,
  ImageViewer,
  MediaThumb,
  ToggleHeading,
  VIDEO_TYPES,
} from './Media.tsx'
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

interface Row {
  key: string
  scenario: ScenarioEvidence
  artifact: Artifact
}

const keyOf = (scenario: ScenarioEvidence) =>
  `${scenario.role}:${scenario.scenario}`

/** "b1-lights-out: checkbox and badge" reads as a short tag and a sentence. */
function splitName(name: string) {
  const match = /^([\w.-]{1,32}):\s+(.+)$/.exec(name)
  return match ? { tag: match[1]!, text: match[2]! } : { tag: null, text: name }
}

function kindLabel(artifact: Artifact) {
  if (artifact.prunedAt) return 'Removed'
  if (IMAGE_TYPES.has(artifact.mediaType)) return 'Screenshot'
  if (VIDEO_TYPES.has(artifact.mediaType)) return 'Recording'
  return 'Test output'
}

function ScenarioChecklist({ detail }: { detail: TicketResponse }) {
  const id = useId()
  const [viewing, setViewing] = useState<number | null>(null)
  const [cardOpen, setCardOpen] = useState(true)
  const rows: Row[] = (detail.evidenceIndex ?? []).map((scenario) => ({
    key: keyOf(scenario),
    scenario,
    artifact: detail.artifacts.find((a) => a.id === scenario.artifactId)!,
  }))
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        rows
          .filter(({ scenario }) => scenario.result !== 'passed')
          .map((row) => row.key),
      ),
  )
  const current = rows.filter(({ scenario }) => scenario.current)
  const earlier = rows.filter(({ scenario }) => !scenario.current)
  const [earlierOpen, setEarlierOpen] = useState(
    () =>
      !current.length ||
      earlier.some(({ scenario }) => scenario.result !== 'passed'),
  )
  if (!rows.length) return null
  const images = current
    .filter(
      ({ artifact }) =>
        !artifact.prunedAt && IMAGE_TYPES.has(artifact.mediaType),
    )
    .map(({ artifact }) => artifact)
  const passed = rows.filter(({ scenario }) => scenario.result === 'passed')
  const failed = rows.length - passed.length
  const allOpen = rows.every((row) => open.has(row.key))
  const toggle = (key: string) => {
    const next = new Set(open)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setOpen(next)
  }
  const list = (items: Row[]) => (
    <ul className="scenario-list">
      {items.map((row) => (
        <ScenarioRow
          key={row.key}
          row={row}
          ticketNumber={detail.ticket.number}
          open={open.has(row.key)}
          onToggle={() => toggle(row.key)}
          onEnlarge={
            images.includes(row.artifact)
              ? () => setViewing(images.indexOf(row.artifact))
              : undefined
          }
        />
      ))}
    </ul>
  )
  const commit = current[0]?.scenario.commit?.slice(0, 7)
  return (
    <section className="evidence-card" aria-label="Scenario evidence">
      <div className="card-heading">
        <ToggleHeading
          level="h2"
          className="section-title"
          open={cardOpen}
          onToggle={() => setCardOpen(!cardOpen)}
          controls={`${id}-body`}
        >
          Scenario evidence
        </ToggleHeading>
        <span className="scenario-tally">
          <span className="result-pill passed">{passed.length} passed</span>
          {failed > 0 && (
            <span className="result-pill failed">{failed} failed</span>
          )}
        </span>
        {cardOpen && (
          <button
            type="button"
            className="quiet small"
            onClick={() => {
              setOpen(allOpen ? new Set() : new Set(rows.map((r) => r.key)))
              if (!allOpen) setEarlierOpen(true)
            }}
          >
            {allOpen ? 'Collapse all' : 'Expand all'}
          </button>
        )}
      </div>
      {cardOpen && (
        <div id={`${id}-body`}>
          {earlier.length === 0 ? (
            list(current)
          ) : (
            <>
              {current.length > 0 && (
                <>
                  <h3 className="group-heading static">
                    <span className="group-name">Current commit</span>
                    {commit && <code>{commit}</code>}
                    <span className="count-badge">{current.length}</span>
                  </h3>
                  {list(current)}
                </>
              )}
              <ToggleHeading
                className="group-heading"
                open={earlierOpen}
                onToggle={() => setEarlierOpen(!earlierOpen)}
                controls={`${id}-earlier`}
              >
                <span className="group-name">Earlier commits</span>
                <span className="group-meta">Evidence is archived</span>
                <span className="count-badge">{earlier.length}</span>
              </ToggleHeading>
              {earlierOpen && <div id={`${id}-earlier`}>{list(earlier)}</div>}
            </>
          )}
        </div>
      )}
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

function ScenarioRow({
  row: { scenario, artifact },
  ticketNumber,
  open,
  onToggle,
  onEnlarge,
}: {
  row: Row
  ticketNumber: number
  open: boolean
  onToggle: () => void
  onEnlarge: (() => void) | undefined
}) {
  const { tag, text } = splitName(scenario.scenario)
  const description = artifact.title.startsWith(`${scenario.scenario}:`)
    ? artifact.title.slice(scenario.scenario.length + 1).trim()
    : artifact.title
  const bodyId = `scenario-${artifact.id}-${scenario.role}`
  const thumb = onEnlarge && (
    <MediaThumb artifact={artifact} onOpen={onEnlarge} />
  )
  return (
    <li className={`scenario-row ${scenario.result}${open ? ' open' : ''}`}>
      <div className="scenario-line">
        <span className="scenario-mark" aria-hidden="true">
          <Icon
            name={scenario.result === 'passed' ? 'check' : 'x'}
            size={10}
            stroke={2.8}
          />
        </span>
        <ToggleHeading
          className="scenario-name"
          open={open}
          onToggle={onToggle}
          controls={bodyId}
        >
          {tag && <span className="scenario-tag">{tag}</span>}
          <span className="scenario-text">{text}</span>
        </ToggleHeading>
        <span className="scenario-kind">
          {scenario.current ? kindLabel(artifact) : 'Archived'}
        </span>
        {scenario.current &&
          (thumb && !open ? (
            thumb
          ) : (
            <span className="thumb-slot" aria-hidden="true" />
          ))}
      </div>
      {open && (
        <div className="scenario-body" id={bodyId}>
          {description !== scenario.scenario && (
            <p className="scenario-description">{description}</p>
          )}
          <p className="scenario-meta">
            {scenario.role}: {scenario.result} · Commit{' '}
            <code>{scenario.commit?.slice(0, 7) ?? 'unknown'}</code>
            {scenario.current ? ' · current' : ' · earlier commit'}
            <a
              className="text-link"
              href={`#/tickets/${ticketNumber}/evidence/${artifact.id}`}
            >
              Open evidence item
            </a>
          </p>
          {!scenario.current ? (
            <p className="muted">Earlier evidence is in the archive.</p>
          ) : thumb ? (
            <div className="scenario-preview">{thumb}</div>
          ) : (
            <ArtifactView artifact={artifact} defaultOpen />
          )}
        </div>
      )}
    </li>
  )
}
