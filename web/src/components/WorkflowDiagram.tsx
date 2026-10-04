import { useLayoutEffect, useRef, useState } from 'react'
import type {
  RouteSummary,
  StepSummary,
  WorkflowSummary,
} from '../../../src/api/contract.ts'

interface Edge {
  readonly from: number
  readonly to: number
  readonly lane: number
}

interface Layout {
  /** Vertical centre of each step, relative to the figure. */
  readonly centres: readonly number[]
  readonly width: number
  readonly height: number
}

const LANE = 14
const GUTTER_PAD = 18

/**
 * Draws a workflow as its step list, with loops back on the left and jumps ahead on the right.
 * Give it a `key` per workflow so a different workflow is measured afresh.
 */
export function WorkflowDiagram({ workflow }: { workflow: WorkflowSummary }) {
  const { steps } = workflow
  const position = new Map(steps.map((step, index) => [step.id, index]))
  const back: Omit<Edge, 'lane'>[] = []
  const ahead: Omit<Edge, 'lane'>[] = []
  const seen = new Set<string>()
  steps.forEach((step, from) => {
    for (const route of step.routes) {
      if (route.next.to !== 'step') continue
      const to = position.get(route.next.stepId)
      if (to === undefined || seen.has(`${from}:${to}`)) continue
      seen.add(`${from}:${to}`)
      if (to <= from) back.push({ from, to })
      else if (to > from + 1) ahead.push({ from, to })
    }
  })
  const backEdges = assignLanes(back)
  const aheadEdges = assignLanes(ahead)
  const gutter = (edges: Edge[]) =>
    edges.length === 0
      ? 0
      : GUTTER_PAD + (Math.max(...edges.map((edge) => edge.lane)) + 1) * LANE
  const left = gutter(backEdges)
  const right = gutter(aheadEdges)

  const list = useRef<HTMLOListElement>(null)
  const [layout, setLayout] = useState<Layout | null>(null)
  useLayoutEffect(() => {
    const element = list.current
    if (!element) return
    const measure = () =>
      setLayout({
        centres: [...element.children].map((child) => {
          const node = child as HTMLElement
          return node.offsetTop + node.offsetHeight / 2
        }),
        width: element.offsetWidth,
        height: element.offsetTop + element.offsetHeight,
      })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const centre = (index: number) => layout?.centres[index] ?? 0

  return (
    <figure
      className="diagram"
      style={{ paddingLeft: left, paddingRight: right }}
      aria-label={`${workflow.name} workflow`}
    >
      {layout && layout.centres.length === steps.length && (
        <svg
          className="edges"
          width={layout.width + left + right}
          height={layout.height}
          aria-hidden="true"
        >
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path d="M0 0 L8 4 L0 8 z" fill="context-stroke" />
            </marker>
          </defs>
          {backEdges.map((edge) => {
            const x = left - GUTTER_PAD + 4 - edge.lane * LANE
            return (
              <path
                key={`back-${edge.from}-${edge.to}`}
                className="edge back"
                d={elbow(left, x, centre(edge.from) + 6, centre(edge.to) - 6)}
                markerEnd="url(#arrow)"
              />
            )
          })}
          {aheadEdges.map((edge) => {
            const start = left + layout.width
            const x = start + GUTTER_PAD - 4 + edge.lane * LANE
            return (
              <path
                key={`ahead-${edge.from}-${edge.to}`}
                className="edge ahead"
                d={elbow(start, x, centre(edge.from), centre(edge.to))}
                markerEnd="url(#arrow)"
              />
            )
          })}
        </svg>
      )}
      <ol ref={list} className="steps">
        {steps.map((step, index) => (
          <StepNode
            key={step.id}
            step={step}
            following={steps[index + 1]?.id}
            isBehind={(id) => (position.get(id) ?? Infinity) <= index}
          />
        ))}
      </ol>
      <p className="terminal">Ticket done</p>
    </figure>
  )
}

function StepNode({
  step,
  following,
  isBehind,
}: {
  step: StepSummary
  following: string | undefined
  isBehind: (stepId: string) => boolean
}) {
  const forward = step.routes.find((route) => route.outcome === step.success)
  const continues = forward !== undefined && isDefault(forward, following)
  const chips = step.routes.filter(
    (route) =>
      !(route.outcome === step.success && isDefault(route, following)) &&
      !(route.next.to === 'ask' && route.next.because === 'needs-decision'),
  )
  return (
    <li className={`node ${step.kind}${continues ? ' continues' : ''}`}>
      <span className="glyph" aria-hidden="true" />
      <div className="body">
        <p className="title">
          <code>{step.id}</code>
          <span className="does">{step.does ?? 'you decide'}</span>
        </p>
        {step.instructions && (
          <p className="instructions">{step.instructions}</p>
        )}
        {(chips.length > 0 || step.needs.length > 0) && (
          <ul className="chips">
            {step.needs.map((need) => (
              <li key={need} className="chip need">
                needs {need}
              </li>
            ))}
            {chips.map((route) => (
              <li
                key={route.outcome}
                className={`chip ${
                  route.next.to === 'step'
                    ? isBehind(route.next.stepId)
                      ? 'back'
                      : 'ahead'
                    : route.next.to
                }`}
              >
                {describe(route, step.limit)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  )
}

/** True when a route goes where the list order already shows: the next step, or done after the last. */
function isDefault(route: RouteSummary, following: string | undefined) {
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

/** Gives each edge the innermost lane that no overlapping edge already uses. */
function assignLanes(edges: Omit<Edge, 'lane'>[]): Edge[] {
  const span = (edge: Omit<Edge, 'lane'>) =>
    [Math.min(edge.from, edge.to), Math.max(edge.from, edge.to)] as const
  const placed: Edge[] = []
  for (const edge of [...edges].sort(
    (a, b) => Math.abs(a.from - a.to) - Math.abs(b.from - b.to),
  )) {
    const [low, high] = span(edge)
    let lane = 0
    while (
      placed.some((other) => {
        const [otherLow, otherHigh] = span(other)
        return other.lane === lane && otherLow <= high && low <= otherHigh
      })
    ) {
      lane += 1
    }
    placed.push({ ...edge, lane })
  }
  return placed
}

function elbow(edgeX: number, laneX: number, fromY: number, toY: number) {
  const r = Math.min(6, Math.abs(toY - fromY) / 2)
  const out = laneX < edgeX ? -1 : 1
  const vertical = toY < fromY ? -1 : 1
  return [
    `M ${edgeX} ${fromY}`,
    `H ${laneX - out * r}`,
    `Q ${laneX} ${fromY} ${laneX} ${fromY + vertical * r}`,
    `V ${toY - vertical * r}`,
    `Q ${laneX} ${toY} ${laneX - out * r} ${toY}`,
    `H ${edgeX}`,
  ].join(' ')
}
