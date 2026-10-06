/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- Scrollable logs need keyboard focus so arrow keys can scroll their content. */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Artifact } from '../../../src/api/contract.ts'
import { api } from '../api.ts'
import { ErrorMessage, MarkdownBody } from './Shared.tsx'
import { IMAGE_TYPES, MediaGallery, VIDEO_TYPES } from './Media.tsx'

export function ArtifactView({
  artifact,
  defaultOpen = false,
  live = false,
  ticketNumber,
}: {
  artifact: Artifact
  defaultOpen?: boolean
  live?: boolean
  ticketNumber?: number
}) {
  const [open, setOpen] = useState(defaultOpen)
  const isImage =
    artifact.content === null && IMAGE_TYPES.has(artifact.mediaType)
  const isVideo =
    artifact.content === null && VIDEO_TYPES.has(artifact.mediaType)
  const isText =
    artifact.content !== null ||
    artifact.mediaType.startsWith('text/') ||
    artifact.mediaType === 'application/json'
  const file = useQuery({
    queryKey: ['artifact', artifact.id, live],
    queryFn: ({ signal }) => api.artifact(artifact.id, signal),
    enabled: !artifact.prunedAt && open && artifact.content === null && isText,
    staleTime: Infinity,
    refetchInterval: live ? 3000 : false,
  })
  const content = artifact.content ?? file.data
  const source = api.artifactUrl(artifact.id)
  const address =
    ticketNumber === undefined || artifact.kind !== 'evidence' ? null : (
      <a
        className="text-link"
        href={`#/tickets/${ticketNumber}/evidence/${artifact.id}`}
      >
        Open evidence item
      </a>
    )
  if (artifact.prunedAt)
    return (
      <p className="muted">
        {artifact.title}: removed after {artifact.retentionDays} days {address}
      </p>
    )
  if (isImage || isVideo)
    return <MediaGallery artifacts={[artifact]} ticketNumber={ticketNumber} />
  return (
    <details
      className="artifact"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {artifact.title}{' '}
        {artifact.title.toLowerCase() !== artifact.kind && (
          <span className="muted">{artifact.kind}</span>
        )}
      </summary>
      {open && (
        <>
          {address}
          <ErrorMessage error={file.error} />
          {isText && artifact.content === null && file.isPending && (
            <output className="muted">Loading artifact…</output>
          )}
          {content !== undefined &&
            (artifact.kind !== 'log' &&
            artifact.mediaType === 'text/markdown' ? (
              <MarkdownBody>{content}</MarkdownBody>
            ) : (
              <pre tabIndex={0} aria-label={artifact.title}>
                {content}
              </pre>
            ))}
          {!isText && (
            <a
              className="text-link"
              href={source}
              target="_blank"
              rel="noreferrer"
            >
              Open file
            </a>
          )}
        </>
      )}
    </details>
  )
}
