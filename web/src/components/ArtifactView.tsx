/* eslint-disable jsx-a11y/media-has-caption -- Evidence recordings have no caption track in the artifact contract; retain native playback and audio controls. */
/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- Scrollable logs need keyboard focus so arrow keys can scroll their content. */
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Artifact } from '../../../src/api/contract.ts'
import { api } from '../api.ts'
import { ErrorMessage, MarkdownBody } from './Shared.tsx'

const images = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const videos = new Set(['video/webm', 'video/mp4'])

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
  const [viewing, setViewing] = useState(false)
  const isImage = artifact.content === null && images.has(artifact.mediaType)
  const isVideo = artifact.content === null && videos.has(artifact.mediaType)
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
    return (
      <figure className="media-evidence">
        <figcaption>
          {artifact.title} {address}
        </figcaption>
        {isImage ? (
          <>
            <button
              className="evidence-thumbnail"
              aria-label={`Enlarge ${artifact.title}`}
              onClick={() => setViewing(true)}
            >
              <img src={source} alt={artifact.title} loading="lazy" />
            </button>
            {viewing && (
              <ImageViewer
                artifact={artifact}
                onClose={() => setViewing(false)}
              />
            )}
          </>
        ) : (
          <video
            controls
            preload="metadata"
            playsInline
            src={source}
            aria-label={artifact.title}
          >
            <a className="text-link" href={source}>
              Open recording
            </a>
          </video>
        )}
        <a
          className="text-link evidence-original"
          href={source}
          target="_blank"
          rel="noreferrer"
        >
          Open original
        </a>
      </figure>
    )
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

function ImageViewer({
  artifact,
  onClose,
}: {
  artifact: Artifact
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => element.close()
  }, [])
  const close = () => {
    dialog.current?.close()
    onClose()
  }
  return (
    <dialog
      ref={dialog}
      className="evidence-viewer"
      aria-labelledby={`image-title-${artifact.id}`}
      onClose={onClose}
      onCancel={(event) => {
        // Clear React state before a quick reopen can race the native close event.
        event.preventDefault()
        close()
      }}
    >
      <div className="viewer-heading">
        <h2 id={`image-title-${artifact.id}`}>{artifact.title}</h2>
        <button autoFocus onClick={close}>
          Close image
        </button>
      </div>
      <img src={api.artifactUrl(artifact.id)} alt={artifact.title} />
    </dialog>
  )
}
