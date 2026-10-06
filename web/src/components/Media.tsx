/* eslint-disable jsx-a11y/media-has-caption -- Evidence recordings have no caption track in the artifact contract; retain native playback and audio controls. */
import { useEffect, useRef, useState } from 'react'
import type { Artifact } from '../../../src/api/contract.ts'
import { api } from '../api.ts'
import { Icon } from './Icon.tsx'

export const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])
export const VIDEO_TYPES = new Set(['video/webm', 'video/mp4'])

export function isMedia(artifact: Artifact) {
  return (
    artifact.content === null &&
    !artifact.prunedAt &&
    (IMAGE_TYPES.has(artifact.mediaType) || VIDEO_TYPES.has(artifact.mediaType))
  )
}

type Shape = 'phone' | 'page' | 'screen'

function shapeOf(width: number, height: number): Shape {
  if (width <= 600 && height > width * 1.3) return 'phone'
  return height > width * 1.15 ? 'page' : 'screen'
}
const SHAPE_WORDS: Record<Shape, string> = {
  phone: 'Phone',
  page: 'Full page',
  screen: 'Screen',
}

/** Screenshots and recordings as equal tiles; images open in one viewer that pages through the set. */
export function MediaGallery({
  artifacts,
  ticketNumber,
  compact = false,
}: {
  artifacts: readonly Artifact[]
  ticketNumber?: number | undefined
  compact?: boolean
}) {
  const [viewing, setViewing] = useState<number | null>(null)
  const images = artifacts.filter((item) => IMAGE_TYPES.has(item.mediaType))
  return (
    <div className={`media-gallery${compact ? ' compact' : ''}`}>
      {artifacts.map((artifact) => (
        <MediaTile
          key={artifact.id}
          artifact={artifact}
          ticketNumber={compact ? undefined : ticketNumber}
          onOpen={() => setViewing(images.indexOf(artifact))}
        />
      ))}
      {viewing !== null && images[viewing] && (
        <ImageViewer
          images={images}
          index={viewing}
          onIndex={setViewing}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  )
}

/** A small framed preview that opens the viewer. */
export function MediaThumb({
  artifact,
  onOpen,
}: {
  artifact: Artifact
  onOpen: () => void
}) {
  return (
    <button
      className="media-frame media-thumb"
      aria-label={`Enlarge ${artifact.title}`}
      onClick={onOpen}
    >
      <img
        src={api.artifactUrl(artifact.id)}
        alt={artifact.title}
        loading="lazy"
      />
    </button>
  )
}

function MediaTile({
  artifact,
  ticketNumber,
  onOpen,
}: {
  artifact: Artifact
  ticketNumber: number | undefined
  onOpen: () => void
}) {
  const [shape, setShape] = useState<Shape | null>(null)
  const source = api.artifactUrl(artifact.id)
  const image = IMAGE_TYPES.has(artifact.mediaType)
  return (
    <figure className="media-tile">
      {image ? (
        <button
          className={`media-frame ${shape ?? ''}`}
          aria-label={`Enlarge ${artifact.title}`}
          onClick={onOpen}
        >
          <img
            src={source}
            alt={artifact.title}
            loading="lazy"
            onLoad={(event) =>
              setShape(
                shapeOf(
                  event.currentTarget.naturalWidth,
                  event.currentTarget.naturalHeight,
                ),
              )
            }
          />
          <span className="media-zoom" aria-hidden="true">
            <Icon name="plus" size={14} stroke={2.2} />
          </span>
        </button>
      ) : (
        <div className="media-frame video">
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
        </div>
      )}
      <figcaption>
        <span className="media-title" title={artifact.title}>
          {artifact.title}
        </span>
        <span className="media-meta">
          <span>
            {image ? (shape ? SHAPE_WORDS[shape] : 'Screenshot') : 'Recording'}
          </span>
          {ticketNumber !== undefined && artifact.kind === 'evidence' && (
            <a
              className="text-link"
              href={`#/tickets/${ticketNumber}/evidence/${artifact.id}`}
            >
              Open evidence item
            </a>
          )}
          {!image && (
            <a
              className="text-link"
              href={source}
              target="_blank"
              rel="noreferrer"
            >
              Open original
            </a>
          )}
        </span>
      </figcaption>
    </figure>
  )
}

export function ImageViewer({
  images,
  index,
  onIndex,
  onClose,
}: {
  images: readonly Artifact[]
  index: number
  onIndex: (index: number) => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const artifact = images[index]!
  const source = api.artifactUrl(artifact.id)
  const many = images.length > 1
  const step = (by: number) =>
    onIndex((index + by + images.length) % images.length)
  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    closeButton.current?.focus()
    return () => element.close()
  }, [])
  useEffect(() => {
    const count = images.length
    if (count < 2) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight') onIndex((index + 1) % count)
      if (event.key === 'ArrowLeft') onIndex((index - 1 + count) % count)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, images.length, onIndex])
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
        <div className="viewer-title">
          <h2 id={`image-title-${artifact.id}`}>{artifact.title}</h2>
          {many && (
            <span className="muted">
              {index + 1} of {images.length}
            </span>
          )}
        </div>
        <a className="text-link" href={source} target="_blank" rel="noreferrer">
          Open original ↗
        </a>
        <button ref={closeButton} onClick={close}>
          Close image
        </button>
      </div>
      <div className="viewer-stage" key={artifact.id}>
        <img src={source} alt={artifact.title} />
      </div>
      {many && (
        <>
          <button
            className="viewer-step previous"
            aria-label="Previous image"
            onClick={() => step(-1)}
          >
            <Icon name="chevronLeft" size={18} stroke={2.2} />
          </button>
          <button
            className="viewer-step next"
            aria-label="Next image"
            onClick={() => step(1)}
          >
            <Icon name="chevronRight" size={18} stroke={2.2} />
          </button>
        </>
      )}
    </dialog>
  )
}
