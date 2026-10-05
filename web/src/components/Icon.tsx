import type { ReactNode } from 'react'
import type { StepSummary } from '../../../src/api/contract.ts'

const SHAPES: Record<string, ReactNode> = {
  map: (
    <>
      <path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6z" />
      <path d="M9 4v14M15 6v14" />
    </>
  ),
  hammer: (
    <>
      <path d="M13.5 7.5 5 16a1.8 1.8 0 0 0 2.5 2.5L16 10" />
      <path d="m11 5 3-2 7 6-2.5 2.8L14 8.5" />
    </>
  ),
  flask: (
    <>
      <path d="M9.5 3h5M10 3v6L4.6 18.2A1.9 1.9 0 0 0 6.2 21h11.6a1.9 1.9 0 0 0 1.6-2.8L14 9V3" />
      <path d="M7.3 14.5h9.4" />
    </>
  ),
  bug: (
    <>
      <rect x="7" y="8" width="10" height="12" rx="5" />
      <path d="M9.5 8V6.5a2.5 2.5 0 0 1 5 0V8M12 12v8M3.5 13H7M17 13h3.5M4.5 8.5 7 10M19.5 8.5 17 10M4.5 18.5 7 16.5M19.5 18.5 17 16.5" />
    </>
  ),
  eye: (
    <>
      <path d="M2.8 12S6 5.5 12 5.5 21.2 12 21.2 12 18 18.5 12 18.5 2.8 12 2.8 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  pen: (
    <>
      <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" />
      <path d="m13.5 6.5 4 4" />
    </>
  ),
  box: (
    <>
      <path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z" />
      <path d="m3.5 7.5 8.5 4.5 8.5-4.5M12 12v9" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.9 7.5-9.5V6z" />
      <path d="m8.8 12.2 2.3 2.3 4.3-4.6" />
    </>
  ),
  pr: (
    <>
      <circle cx="6.5" cy="5.5" r="2" />
      <circle cx="6.5" cy="18.5" r="2" />
      <circle cx="17.5" cy="18.5" r="2" />
      <path d="M6.5 7.5v9M17.5 16.5V10a3 3 0 0 0-3-3H11" />
      <path d="m13 4.5-2.5 2.5L13 9.5" />
    </>
  ),
  merge: (
    <>
      <circle cx="6.5" cy="5.5" r="2" />
      <circle cx="6.5" cy="18.5" r="2" />
      <circle cx="17.5" cy="13" r="2" />
      <path d="M6.5 7.5v9M6.5 7.5c0 3.5 3 5.5 9 5.5" />
    </>
  ),
  layers: (
    <>
      <path d="M12 3 2.8 8 12 13l9.2-5z" />
      <path d="m2.8 12.5 9.2 5 9.2-5M2.8 16.5l9.2 5 9.2-5" />
    </>
  ),
  hourglass: (
    <path d="M6.5 3h11M6.5 21h11M7.5 3c0 5 9 5 9 9s-9 4-9 9M16.5 3c0 5-9 5-9 9s9 4 9 9" />
  ),
  sparkle: (
    <path d="M12 3c.6 4.6 2.4 6.4 7 7-4.6.6-6.4 2.4-7 7-.6-4.6-2.4-6.4-7-7 4.6-.6 6.4-2.4 7-7z" />
  ),
  hand: (
    <>
      <path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V12" />
      <path d="M11 11.5V5a1.5 1.5 0 0 1 3 0v6.5" />
      <path d="M14 11.5V6.5a1.5 1.5 0 0 1 3 0V14c0 3.9-2.6 7-6.3 7-2.4 0-4-1.1-5.3-3.1L4 15.4a1.5 1.5 0 0 1 2.5-1.6L8 15.5" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  chevronDown: <path d="m5.5 9.5 6.5 6.5 6.5-6.5" />,
  chevronLeft: <path d="M14.5 5.5 8 12l6.5 6.5" />,
  chevronRight: <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />,
  flag: <path d="M5 21V4M5 4h11l-2 4 2 4H5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  dots: (
    <>
      <circle cx="5.5" cy="12" r="1.1" />
      <circle cx="12" cy="12" r="1.1" />
      <circle cx="18.5" cy="12" r="1.1" />
    </>
  ),
}

export function Icon({
  name,
  size = 16,
  stroke = 1.7,
}: {
  name: string
  size?: number
  stroke?: number
}) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {SHAPES[name] ?? SHAPES['dots']}
    </svg>
  )
}

const STEP_ICONS: Record<string, string> = {
  planner: 'map',
  builder: 'hammer',
  tester: 'flask',
  reproducer: 'bug',
  reviewer: 'eye',
  writer: 'pen',
  onboarder: 'box',
  'verify-kit': 'shield',
  'maintain-pr': 'pr',
  merge: 'merge',
  split: 'layers',
  'wait-children': 'hourglass',
  decide: 'sparkle',
}

/** The glyph for a step: its role or action, or a raised hand for you. */
export function stepIcon(step: StepSummary | undefined) {
  if (!step || step.kind === 'human') return 'hand'
  return STEP_ICONS[step.does ?? ''] ?? 'dots'
}

/** Role hue names, matched to CSS custom properties. */
export function stepHue(step: StepSummary | undefined) {
  if (!step || step.kind === 'human') return 'amber'
  if (step.kind === 'system') return 'blue'
  return (
    {
      planner: 'indigo',
      builder: 'orange',
      tester: 'green',
      reproducer: 'red',
      reviewer: 'purple',
      writer: 'teal',
      onboarder: 'brown',
    }[step.does ?? ''] ?? 'grey'
  )
}
