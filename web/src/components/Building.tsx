import type { CSSProperties } from 'react'

// The logo's K, lit dot by dot on a larger LED panel above a moving belt.
const COLUMNS = 15
const ROWS = 9
const PITCH = 10
const K_ORIGIN = { column: 5, row: 1 }
const BELT_ROW = 7
const BUILD_ORDER = [0, 5, 10, 15, 20, 11, 7, 3, 17, 23]

function centre(column: number, row: number) {
  return { cx: column * PITCH + PITCH / 2, cy: row * PITCH + PITCH / 2 }
}

export function Building() {
  const lit = new Map(
    BUILD_ORDER.map((index, order) => [
      `${K_ORIGIN.column + (index % 5)}:${K_ORIGIN.row + Math.floor(index / 5)}`,
      order,
    ]),
  )
  const background = []
  const belt = []
  const build = []
  for (let row = 0; row < ROWS; row++)
    for (let column = 0; column < COLUMNS; column++) {
      const key = `${column}:${row}`
      const order = lit.get(key)
      if (order !== undefined)
        build.push(
          <circle
            key={key}
            {...centre(column, row)}
            r={3.4}
            className="build-dot"
            style={{ '--i': order } as CSSProperties}
          />,
        )
      else if (row === BELT_ROW)
        belt.push(
          <circle
            key={key}
            {...centre(column, row)}
            r={2.2}
            className="belt-dot"
            style={{ '--i': column } as CSSProperties}
          />,
        )
      else
        background.push(
          <circle
            key={key}
            {...centre(column, row)}
            r={2.2}
            className="idle-dot"
          />,
        )
    }
  return (
    <svg
      className="building"
      viewBox={`-6 -6 ${COLUMNS * PITCH + 12} ${ROWS * PITCH + 12}`}
      aria-hidden="true"
    >
      <defs>
        <filter id="building-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <rect
        x={-6}
        y={-6}
        width={COLUMNS * PITCH + 12}
        height={ROWS * PITCH + 12}
        rx={14}
        className="building-panel"
      />
      {background}
      {belt}
      <g filter="url(#building-glow)">{build}</g>
    </svg>
  )
}
