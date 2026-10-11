import type { Artifact, TicketResponse } from '../../../src/api/contract.ts'

function typeLabel(artifact: Artifact) {
  if (artifact.mediaType === 'inode/directory') return 'Page'
  if (artifact.mediaType === 'application/pdf') return 'PDF'
  if (artifact.mediaType.startsWith('image/')) return 'Image'
  if (artifact.mediaType.startsWith('video/')) return 'Video'
  return 'File'
}

function OutputList({ outputs }: { outputs: readonly Artifact[] }) {
  return (
    <ul className="output-list">
      {outputs.map((output) => (
        <li key={output.id}>
          <a href={output.url!} target="_blank" rel="noopener noreferrer">
            {output.title}
          </a>
          <span className="muted">{typeLabel(output)}</span>
        </li>
      ))}
    </ul>
  )
}

/** What the ticket made to open in the browser; the latest run first, earlier rounds folded away. */
export function Outputs({ detail }: { detail: TicketResponse }) {
  const outputs = detail.artifacts.filter(
    (artifact) => artifact.kind === 'output' && artifact.url,
  )
  if (!outputs.length) return null
  const latest = outputs.at(-1)!.attemptId
  const earlier = outputs.filter((output) => output.attemptId !== latest)
  return (
    <section className="evidence-card" aria-labelledby="outputs-heading">
      <h2 className="section-title" id="outputs-heading">
        Outputs
      </h2>
      <OutputList
        outputs={outputs.filter((output) => output.attemptId === latest)}
      />
      {earlier.length > 0 && (
        <details>
          <summary>Earlier outputs ({earlier.length})</summary>
          <OutputList outputs={earlier} />
        </details>
      )}
    </section>
  )
}
