/* eslint-disable jsx-a11y/media-has-caption -- Evidence recordings have no caption track in the artifact contract; retain native playback and audio controls. */
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import type { Artifact, Attempt } from '../../../src/api/contract.ts'
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

/** A heading whose button folds the content it controls. */
export function ToggleHeading({
  open,
  onToggle,
  controls,
  level = 'h3',
  className = '',
  children,
}: {
  open: boolean
  onToggle: () => void
  controls: string
  level?: 'h2' | 'h3'
  className?: string
  children: ReactNode
}) {
  const Heading = level
  return (
    <Heading className={`toggle-heading ${className}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={controls}
        onClick={onToggle}
      >
        <span className="toggle-chevron" aria-hidden="true">
          <Icon name="chevronRight" size={14} stroke={2.2} />
        </span>
        {children}
      </button>
    </Heading>
  )
}

/** Screenshots and recordings as equal tiles; images open in one viewer that pages through the set. */
export function MediaGallery({
  artifacts,
  ticketNumber,
  compact = false,
  limit,
}: {
  artifacts: readonly Artifact[]
  ticketNumber?: number | undefined
  compact?: boolean
  limit?: number
}) {
  const [viewing, setViewing] = useState<number | null>(null)
  const [all, setAll] = useState(false)
  const images = artifacts.filter((item) => IMAGE_TYPES.has(item.mediaType))
  // Folding away a single tile saves no space, so only fold two or more.
  const foldable = limit !== undefined && artifacts.length > limit + 1
  const shown = foldable && !all ? artifacts.slice(0, limit) : artifacts
  return (
    <div className={`media-gallery${compact ? ' compact' : ''}`}>
      {shown.map((artifact) => (
        <MediaTile
          key={artifact.id}
          artifact={artifact}
          ticketNumber={compact ? undefined : ticketNumber}
          onOpen={() => setViewing(images.indexOf(artifact))}
        />
      ))}
      {foldable && (
        <button
          type="button"
          className="media-more"
          aria-expanded={all}
          onClick={() => setAll(!all)}
        >
          {all ? 'Show fewer' : `Show all ${artifacts.length}`}
        </button>
      )}
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

const LIBRARY_SHOWN = 8

function when(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Every loose screenshot and recording, grouped by the run that captured it, newest run first. */
export function MediaLibrary({
  artifacts,
  attempts,
  ticketNumber,
}: {
  artifacts: readonly Artifact[]
  attempts: readonly Attempt[]
  ticketNumber: number
}) {
  const id = useId()
  const [open, setOpen] = useState(true)
  const [filter, setFilter] = useState<'all' | 'image' | 'video'>('all')
  const [openRuns, setOpenRuns] = useState<ReadonlySet<number> | null>(null)
  const imageCount = artifacts.filter((a) =>
    IMAGE_TYPES.has(a.mediaType),
  ).length
  const videoCount = artifacts.length - imageCount
  const shown = artifacts.filter((a) =>
    filter === 'all'
      ? true
      : (filter === 'image') === IMAGE_TYPES.has(a.mediaType),
  )
  const runs = [...new Set(shown.map((a) => a.attemptId))]
    .map((attemptId) => ({
      attemptId,
      attempt: attempts.find((a) => a.id === attemptId),
      items: shown.filter((a) => a.attemptId === attemptId),
    }))
    .sort((a, b) => b.attemptId - a.attemptId)
  const expanded = openRuns ?? new Set(runs.slice(0, 1).map((r) => r.attemptId))
  const toggleRun = (attemptId: number) => {
    const next = new Set(expanded)
    if (next.has(attemptId)) next.delete(attemptId)
    else next.add(attemptId)
    setOpenRuns(next)
  }
  const filters = [
    ['all', 'All', artifacts.length],
    ['image', 'Screenshots', imageCount],
    ['video', 'Recordings', videoCount],
  ] as const
  return (
    <section
      className="attachments evidence-card"
      aria-labelledby={`${id}-heading`}
    >
      <div className="card-heading">
        <ToggleHeading
          level="h2"
          className="section-title"
          open={open}
          onToggle={() => setOpen(!open)}
          controls={`${id}-body`}
        >
          <span id={`${id}-heading`}>Screenshots and recordings</span>
          <span className="count-badge">{artifacts.length}</span>
        </ToggleHeading>
        {open && imageCount > 0 && videoCount > 0 && (
          <fieldset className="segmented" aria-label="Show">
            {filters.map(([value, label, count]) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {label} <span className="muted">{count}</span>
              </button>
            ))}
          </fieldset>
        )}
      </div>
      {open && (
        <div id={`${id}-body`} className="media-runs">
          {runs.length === 1 ? (
            <MediaGallery
              artifacts={runs[0]!.items}
              ticketNumber={ticketNumber}
              limit={LIBRARY_SHOWN}
            />
          ) : (
            runs.map(({ attemptId, attempt, items }) => {
              const runOpen = expanded.has(attemptId)
              return (
                <div className="media-run" key={attemptId}>
                  <ToggleHeading
                    className="group-heading"
                    open={runOpen}
                    onToggle={() => toggleRun(attemptId)}
                    controls={`${id}-run-${attemptId}`}
                  >
                    <span className="group-name">
                      {attempt?.stepId ?? 'Earlier run'}
                    </span>
                    {attempt && (
                      <span className="group-meta">
                        {when(attempt.finishedAt ?? attempt.createdAt)}
                      </span>
                    )}
                    <span className="count-badge">{items.length}</span>
                  </ToggleHeading>
                  {runOpen && (
                    <div id={`${id}-run-${attemptId}`}>
                      <MediaGallery
                        artifacts={items}
                        ticketNumber={ticketNumber}
                        limit={LIBRARY_SHOWN}
                      />
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      )}
    </section>
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
    // Clicks on the dimmed area around the image close the viewer; Escape is the keyboard path.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <dialog
      ref={dialog}
      className="evidence-viewer"
      aria-labelledby={`image-title-${artifact.id}`}
      // A close queued by an effect cleanup can land after the remount reopened the dialog.
      onClose={() => {
        if (!dialog.current?.open) onClose()
      }}
      onCancel={(event) => {
        // Clear React state before a quick reopen can race the native close event.
        event.preventDefault()
        close()
      }}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('img, a, button')) return
        close()
      }}
    >
      <div className="viewer-heading">
        <div className="viewer-title">
          <h2 id={`image-title-${artifact.id}`}>{artifact.title}</h2>
          {many && (
            <span className="viewer-count">
              {index + 1} / {images.length}
            </span>
          )}
        </div>
        <a
          className="viewer-original"
          href={source}
          target="_blank"
          rel="noreferrer"
        >
          Open original ↗
        </a>
        <button
          ref={closeButton}
          className="viewer-close"
          aria-label="Close image"
          title="Close (Esc)"
          onClick={close}
        >
          <Icon name="x" size={18} stroke={2} />
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
            <Icon name="chevronLeft" size={20} stroke={2.2} />
          </button>
          <button
            className="viewer-step next"
            aria-label="Next image"
            onClick={() => step(1)}
          >
            <Icon name="chevronRight" size={20} stroke={2.2} />
          </button>
        </>
      )}
    </dialog>
  )
}
