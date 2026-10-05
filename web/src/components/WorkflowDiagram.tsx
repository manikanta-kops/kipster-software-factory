import { useLayoutEffect, useRef, useState } from 'react'
import type {
  RouteSummary,
  StepSummary,
  WorkflowSummary,
} from '../../../src/api/contract.ts'
import { Icon, stepHue, stepIcon } from './Icon.tsx'

interface Arc {
  readonly from: number
  readonly to: number
  readonly level: number
  readonly label: string
  readonly back: boolean
}

interface Centre {
  readonly x: number
  readonly y: number
  readonly r: number
}

/**
 * A workflow as one line of steps. Loops and jumps are drawn only for the selected
 * step, or for every step when asked, so lines never pile up.
 * Give it a `key` per workflow so a different workflow is measured afresh.
 */
export function WorkflowDiagram({ workflow }: { workflow: WorkflowSummary }) {
  const { steps } = workflow
  const [selected, setSelected] = useState<string | null>(null)
  const [all, setAll] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const [centres, setCentres] = useState<readonly Centre[]>([])
  const [size, setSize] = useState({ width: 0, height: 0 })

  useLayoutEffect(() => {
    const element = wrap.current
    if (!element) return
    const measure = () => {
      const box = element.getBoundingClientRect()
      setSize({ width: element.scrollWidth, height: element.offsetHeight })
      setCentres(
        [...element.querySelectorAll<HTMLElement>('.station-node')].map(
          (node) => {
            const rect = node.getBoundingClientRect()
            return {
              x: rect.left + rect.width / 2 - box.left,
              y: rect.top + rect.height / 2 - box.top,
              r: rect.width / 2,
            }
          },
        ),
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const arcs = arcsFor(steps, (from, to) => {
    if (all) return true
    const id = selected
    return id !== null && (steps[from]!.id === id || steps[to]!.id === id)
  })

  return (
    <figure className="track-figure" aria-label={`${workflow.name} workflow`}>
      <div className="track-tools">
        <label className="switch">
          <input
            type="checkbox"
            checked={all}
            onChange={(event) => setAll(event.target.checked)}
          />
          <span aria-hidden="true" />
          Show all loops
        </label>
        <span className="muted">
          {selected
            ? 'Showing where this step can send a ticket.'
            : 'Select a step to see where it can send a ticket.'}
        </span>
      </div>
      <div className="track-scroll">
        <div className="track" ref={wrap}>
          <svg
            className="edges"
            width={size.width}
            height={size.height}
            aria-hidden="true"
          >
            {centres.length === steps.length &&
              arcs.map((arc) => (
                <ArcPath
                  key={`${arc.from}-${arc.to}`}
                  arc={arc}
                  from={centres[arc.from]!}
                  to={centres[arc.to]!}
                />
              ))}
          </svg>
          <span className="track-start" aria-hidden="true" />
          <ol className="stations">
            {steps.map((step) => (
              <li
                key={step.id}
                className={`station hue-${stepHue(step)}${
                  selected === step.id ? ' selected' : ''
                }`}
              >
                <button
                  type="button"
                  className={`station-node${step.kind === 'human' ? ' human' : ''}`}
                  aria-pressed={selected === step.id}
                  aria-label={`${step.id}: ${step.does ?? 'you decide'}`}
                  onClick={() =>
                    setSelected(selected === step.id ? null : step.id)
                  }
                >
                  <Icon name={stepIcon(step)} size={17} />
                </button>
                <span className="station-id">{step.id}</span>
                {step.does !== step.id && (
                  <span className="station-does">
                    {step.does ?? 'you decide'}
                  </span>
                )}
                {(step.needs.length > 0 || step.limit !== undefined) && (
                  <span className="station-tags">
                    {step.needs.map((need) => (
                      <span key={need}>needs {need}</span>
                    ))}
                    {step.limit !== undefined && (
                      <span>up to {step.limit}×</span>
                    )}
                  </span>
                )}
              </li>
            ))}
          </ol>
          <span className="track-end" aria-hidden="true">
            <Icon name="check" size={13} stroke={2.6} />
          </span>
        </div>
      </div>
      <dl className="routes">
        {steps.map((step, index) => {
          const shown = step.routes.filter(
            (route) =>
              !isDefault(route, step, steps[index + 1]?.id) &&
              !(
                route.next.to === 'ask' &&
                route.next.because === 'needs-decision'
              ),
          )
          if (!shown.length && !step.instructions) return null
          return (
            <div
              key={step.id}
              className={selected === step.id ? 'selected' : undefined}
            >
              <dt>{step.id}</dt>
              <dd>
                {shown.map((route) => (
                  <span key={route.outcome} className="route">
                    {describe(route, step.limit)}
                  </span>
                ))}
                {step.instructions && (
                  <span className="instructions">{step.instructions}</span>
                )}
              </dd>
            </div>
          )
        })}
      </dl>
    </figure>
  )
}

function ArcPath({ arc, from, to }: { arc: Arc; from: Centre; to: Centre }) {
  const direction = Math.sign(to.x - from.x) || -1
  const startX = from.x + direction * 7
  const endX = to.x - direction * 7
  const y = from.y - from.r - 3
  const top = from.y - from.r - 30 - arc.level * 22
  const r = 9
  const d = [
    `M ${startX} ${y}`,
    `L ${startX} ${top + r}`,
    `Q ${startX} ${top} ${startX + direction * r} ${top}`,
    `L ${endX - direction * r} ${top}`,
    `Q ${endX} ${top} ${endX} ${top + r}`,
    `L ${endX} ${y}`,
  ].join(' ')
  return (
    <g className={`arc ${arc.back ? 'back' : 'ahead'}`}>
      <path className={`edge ${arc.back ? 'back' : 'ahead'}`} d={d} />
      <path
        className="arc-tip"
        d={`M ${endX - 4} ${y - 6} L ${endX} ${y} L ${endX + 4} ${y - 6}`}
      />
      <text x={(startX + endX) / 2} y={top - 6} textAnchor="middle">
        {arc.label}
      </text>
    </g>
  )
}

/** Loops back and jumps ahead, levelled so overlapping arcs stack instead of crossing. */
function arcsFor(
  steps: readonly StepSummary[],
  include: (from: number, to: number) => boolean,
): Arc[] {
  const position = new Map(steps.map((step, index) => [step.id, index]))
  const grouped = new Map<
    string,
    { from: number; to: number; labels: string[] }
  >()
  steps.forEach((step, from) => {
    for (const route of step.routes) {
      if (route.next.to !== 'step') continue
      const to = position.get(route.next.stepId)
      if (to === undefined || to === from + 1) continue
      if (!include(from, to)) continue
      const key = `${from}:${to}`
      const entry = grouped.get(key) ?? { from, to, labels: [] }
      entry.labels.push(
        route.outcome === 'limit'
          ? `after ${step.limit} rounds`
          : route.outcome.replaceAll('-', ' '),
      )
      grouped.set(key, entry)
    }
  })
  const levels: (readonly [number, number])[][] = []
  return [...grouped.values()]
    .sort((a, b) => Math.abs(a.from - a.to) - Math.abs(b.from - b.to))
    .map((entry) => {
      const low = Math.min(entry.from, entry.to)
      const high = Math.max(entry.from, entry.to)
      let level = 0
      while ((levels[level] ?? []).some(([l, h]) => low <= h && high >= l))
        level += 1
      ;(levels[level] ??= []).push([low, high])
      const limit = steps[entry.from]!.limit
      const back = entry.to <= entry.from
      return {
        from: entry.from,
        to: entry.to,
        level,
        back,
        label:
          entry.labels.join(' or ') +
          (back && limit !== undefined ? ` · up to ${limit}×` : ''),
      }
    })
}

/** True when a route goes where the line already shows: the next step, or done after the last. */
function isDefault(
  route: RouteSummary,
  step: StepSummary,
  following: string | undefined,
) {
  if (route.outcome !== step.success) return false
  return route.next.to === 'step'
    ? route.next.stepId === following
    : route.next.to === 'finish' && following === undefined
}

function describe(route: RouteSummary, limit: number | undefined): string {
  const target =
    route.next.to === 'step'
      ? route.next.stepId
      : route.next.to === 'ask'
        ? 'you'
        : route.next.to
  return route.outcome === 'limit'
    ? `after ${limit} rounds → ${target}`
    : `${route.outcome} → ${target}`
}
