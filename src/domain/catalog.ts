import { z } from 'zod'

/** What a step can report when it finishes, and which report moves the ticket forward. */
export interface StepContract {
  readonly success: string | null
  readonly outcomes: readonly string[]
}

export interface Role extends StepContract {
  readonly summary: string
  readonly changes: 'nothing' | 'code' | 'pull-request' | 'kit'
}

export interface Action {
  readonly summary: string
  readonly params: z.ZodType
  readonly contract: (params: unknown) => StepContract
}

/** Every agent and system step may stop and ask a human instead of finishing. */
export const NEEDS_DECISION = 'needs-decision'

/** Route key used when a step has sent the ticket back `limit` times. */
export const LIMIT = 'limit'

/** Route targets that end or pause a ticket rather than naming a step. */
export const EXITS = ['finish', 'cancel', 'ask'] as const
export type Exit = (typeof EXITS)[number]

export const CAPABILITIES = ['setup', 'verify'] as const

export const roles = {
  planner: {
    summary:
      'Turns a ticket into a plan with acceptance scenarios; may build throwaway prototypes.',
    changes: 'nothing',
    success: 'done',
    outcomes: ['done'],
  },
  builder: {
    summary:
      'The only author of product code. Implements the plan, resolves conflicts and addresses feedback.',
    changes: 'code',
    success: 'done',
    outcomes: ['done', 'needs-other-repo'],
  },
  tester: {
    summary:
      'Runs the real app against the acceptance scenarios and returns a verdict with evidence.',
    changes: 'nothing',
    success: 'passed',
    outcomes: ['passed', 'changes-needed'],
  },
  reproducer: {
    summary:
      'Proves a reported bug on the base branch before anything is fixed.',
    changes: 'nothing',
    success: 'reproduced',
    outcomes: ['reproduced', 'not-reproduced'],
  },
  reviewer: {
    summary:
      'Reads the diff once for unsafe, dishonest or out-of-scope changes the tester cannot see.',
    changes: 'nothing',
    success: 'passed',
    outcomes: ['passed', 'changes-needed'],
  },
  writer: {
    summary:
      'Writes the pull request description: what changed, why, a diagram and the evidence.',
    changes: 'pull-request',
    success: 'done',
    outcomes: ['done'],
  },
  onboarder: {
    summary:
      "Creates a repository's .kipster kit and proves it works once end to end.",
    changes: 'kit',
    success: 'done',
    outcomes: ['done'],
  },
} as const satisfies Record<string, Role>

export type RoleName = keyof typeof roles

export const humanContract: StepContract = {
  success: 'approved',
  outcomes: ['approved', 'changes-needed', 'rejected'],
}

const slug = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, 'use lowercase letters, digits and hyphens')

const confidence = z.number().min(0).max(1)

export const decideParams = z.strictObject({
  question: z.string().min(1),
  options: z
    .record(slug, z.string().min(1))
    .refine((options) => Object.keys(options).length >= 2, {
      message: 'give at least two options',
    }),
  bands: z
    .strictObject({ act: confidence, confirm: confidence })
    .refine((bands) => bands.confirm <= bands.act, {
      message: 'confirm must not be higher than act',
    })
    .default({ act: 0.9, confirm: 0.6 }),
})

export const splitParams = z.strictObject({ workflow: slug })

const noParams = z.strictObject({})

function fixed(success: string, outcomes: readonly string[]) {
  return (): StepContract => ({ success, outcomes })
}

export const actions = {
  'verify-kit': {
    summary:
      'Proves the committed kit with setup, check and an isolated running instance.',
    params: noParams,
    contract: fixed('passed', ['passed', 'failed']),
  },
  decide: {
    summary:
      'Asks the decision model a typed question and routes on its answer and confidence.',
    params: decideParams,
    // A decision has no "forward" answer: each option must be routed or it pauses for a human.
    contract: (params) => ({
      success: null,
      outcomes: Object.keys(decideParams.parse(params).options),
    }),
  },
  'maintain-pr': {
    summary:
      'Keeps the pull request mergeable: syncs with base, waits for CI and refreshes the description.',
    params: z.strictObject({
      ciTimeoutMinutes: z.number().positive().default(60),
      factoryUrl: z.url().optional(),
    }),
    contract: fixed('ready', ['ready', 'conflict', 'ci-failed', 'base-moved']),
  },
  merge: {
    summary:
      'Merges when the repository policy allows it, otherwise waits for a human.',
    params: noParams,
    contract: fixed('merged', ['merged', 'changes-needed', 'rejected']),
  },
  split: {
    summary:
      'Creates one child ticket per planned phase, each running the named workflow.',
    params: splitParams,
    contract: fixed('done', ['done']),
  },
  'wait-children': {
    summary: 'Waits until every child ticket has finished or been deferred.',
    params: noParams,
    contract: fixed('done', ['done', 'deferred']),
  },
} as const satisfies Record<string, Action>

export type ActionName = keyof typeof actions

export function isRole(name: string): name is RoleName {
  return Object.hasOwn(roles, name)
}

export function isAction(name: string): name is ActionName {
  return Object.hasOwn(actions, name)
}
