import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import type { Ticket } from '../../../src/api/contract.ts'
import { humanize, repositoryName, repositoryTone } from '../words.ts'
import { Icon } from './Icon.tsx'

export interface TicketFilter {
  readonly repositories: readonly string[]
  readonly workflows: readonly string[]
}
export const noFilter: TicketFilter = { repositories: [], workflows: [] }

export function isFiltered(filter: TicketFilter) {
  return filter.repositories.length > 0 || filter.workflows.length > 0
}
export function matches(filter: TicketFilter, ticket: Ticket) {
  return (
    (!filter.repositories.length ||
      filter.repositories.includes(ticket.repository.slug)) &&
    (!filter.workflows.length ||
      filter.workflows.includes(ticket.workflow.name))
  )
}

function list(items: readonly string[]) {
  return items.length <= 2
    ? items.join(' and ')
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}
/** The filter in words: "everything", "storefront", "bug work in api". */
export function describeFilter(filter: TicketFilter) {
  const names = filter.repositories.map(repositoryName)
  const kinds = filter.workflows.map((name) => humanize(name).toLowerCase())
  if (!names.length && !kinds.length) return 'everything'
  if (!kinds.length) return list(names)
  if (!names.length) return `${list(kinds)} work`
  return `${list(kinds)} work in ${list(names)}`
}

export interface RepositoryRef {
  readonly id: number
  readonly slug: string
}

export function RepositoryTag({ repository }: { repository: RepositoryRef }) {
  return (
    <span
      className="repo-tag"
      style={repositoryTone(repository.id) as CSSProperties}
    >
      <i aria-hidden="true" />
      {repositoryName(repository.slug)}
    </span>
  )
}
export function RepositoryDot({ id }: { id: number }) {
  return (
    <i
      className="repo-dot"
      style={repositoryTone(id) as CSSProperties}
      aria-hidden="true"
    />
  )
}

/** "Showing everything ▾": a quiet line that opens repository and kind filters. */
export function FilterMenu({
  filter,
  repositories,
  workflows,
  onChange,
}: {
  filter: TicketFilter
  repositories: readonly RepositoryRef[]
  workflows: readonly string[]
  onChange: (filter: TicketFilter) => void
}) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDialogElement>(null)
  const panelId = useId()
  useEffect(() => {
    if (!open) return
    panel.current?.querySelector('input')?.focus()
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!panel.current?.contains(target) && !button.current?.contains(target))
        setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      button.current?.focus()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open])
  const toggle = (key: keyof TicketFilter, value: string) => {
    const current = filter[key]
    onChange({
      ...filter,
      [key]: current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value],
    })
  }
  const single =
    filter.repositories.length === 1 && !filter.workflows.length
      ? repositories.find((item) => item.slug === filter.repositories[0])
      : undefined
  return (
    <div className="filter-line">
      <span>Showing</span>
      <button
        ref={button}
        type="button"
        className="filter-pick"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen(!open)}
      >
        {single && <RepositoryDot id={single.id} />}
        <b>{describeFilter(filter)}</b>
        <Icon name="chevronDown" size={12} stroke={2} />
      </button>
      {isFiltered(filter) && (
        <button
          type="button"
          className="filter-clear"
          onClick={() => onChange(noFilter)}
        >
          Show everything
        </button>
      )}
      {open && (
        <dialog
          ref={panel}
          id={panelId}
          className="filter-panel"
          open
          aria-label="Filters"
        >
          <fieldset>
            <legend>Repositories</legend>
            {repositories.map(({ id, slug }) => (
              <label key={slug} className="filter-option">
                <input
                  type="checkbox"
                  checked={filter.repositories.includes(slug)}
                  onChange={() => toggle('repositories', slug)}
                />
                <RepositoryDot id={id} />
                <span>{repositoryName(slug)}</span>
                <Icon name="check" size={13} stroke={2.4} />
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>Kind of work</legend>
            {workflows.map((name) => (
              <label key={name} className="filter-option">
                <input
                  type="checkbox"
                  checked={filter.workflows.includes(name)}
                  onChange={() => toggle('workflows', name)}
                />
                <i className="kind-dot" aria-hidden="true" />
                <span>{humanize(name)}</span>
                <Icon name="check" size={13} stroke={2.4} />
              </label>
            ))}
          </fieldset>
          <div className="filter-foot">
            <button
              type="button"
              className="quiet"
              disabled={!isFiltered(filter)}
              onClick={() => onChange(noFilter)}
            >
              Clear
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                setOpen(false)
                button.current?.focus()
              }}
            >
              Done
            </button>
          </div>
        </dialog>
      )}
    </div>
  )
}
