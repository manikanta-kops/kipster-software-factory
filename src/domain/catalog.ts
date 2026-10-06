import { z } from 'zod'

/** What a step can report when it finishes, and which report moves the ticket forward. */
export interface StepContract {
  readonly success: string | null
  readonly outcomes: readonly string[]
}

export interface Role extends StepContract {
  readonly summary: string
  readonly changes: 'nothing' | 'code' | 'pull-request' | 'kit'
  readonly skipMissingNeedsInTaskWorkflows?: readonly string[]
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
    skipMissingNeedsInTaskWorkflows: ['task', 'task-pr'],
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
  lead: {
    summary:
      'Splits the ticket into tasks for other agents, reads their reports and decides what happens next.',
    changes: 'nothing',
    success: 'done',
    outcomes: ['done', 'delegate', 'plan-ready'],
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

export const otherRepositoryRequestSchema = z.strictObject({
  repository: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'use owner/name')
    .refine(
      (value) =>
        value.split('/').every((part) => part !== '.' && part !== '..'),
      'use owner/name',
    ),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(100_000),
  workflow: slug.default('lead'),
})
export type OtherRepositoryRequest = z.infer<
  typeof otherRepositoryRequestSchema
>

export const AGENT_CLIS = ['codex', 'claude'] as const
export const EFFORTS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

/** Which CLI, model and effort run an agent session. */
export const agentChoiceSchema = z.strictObject({
  cli: z.enum(AGENT_CLIS),
  model: z.string().min(1).optional(),
  effort: z.enum(EFFORTS).optional(),
})
export type AgentChoice = z.infer<typeof agentChoiceSchema>

/** A lead's request for one task: a child ticket that lands on the lead's branch or as its own pull request. */
export const taskRequestSchema = z.strictObject({
  key: slug,
  title: z.string().trim().min(1).max(200),
  instructions: z.string().trim().min(1).max(100_000),
  land: z.enum(['branch', 'pr']).default('branch'),
  workflow: slug.optional(),
  agent: agentChoiceSchema.optional(),
})
export type TaskRequest = z.infer<typeof taskRequestSchema>

export const pullRequestDecisionSchema = z.strictObject({
  task: slug,
  decision: z.enum(['merge', 'leave-open']),
})
export type PullRequestDecision = z.infer<typeof pullRequestDecisionSchema>

export const runTasksParams = z.strictObject({
  workflow: slug.default('task'),
  prWorkflow: slug.default('task-pr'),
  maxParallel: z.int().positive().default(3),
  maxTasks: z.int().positive().default(12),
})
export type RunTasksParams = z.infer<typeof runTasksParams>

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
      ciSettleMinutes: z.number().nonnegative().default(3),
      maxBaseSyncs: z.int().nonnegative().default(3),
    }),
    contract: fixed('ready', ['ready', 'conflict', 'ci-failed', 'base-moved']),
  },
  merge: {
    summary:
      'Merges when the repository policy allows it, otherwise waits for a human.',
    params: noParams,
    contract: fixed('merged', ['merged', 'changes-needed', 'rejected']),
  },
  'run-tasks': {
    summary:
      "Runs a lead's tasks as child tickets and reports back each time one finishes.",
    params: runTasksParams,
    contract: fixed('reported', ['reported']),
  },
} as const satisfies Record<string, Action>

export type ActionName = keyof typeof actions

export function isRole(name: string): name is RoleName {
  return Object.hasOwn(roles, name)
}

export function isAction(name: string): name is ActionName {
  return Object.hasOwn(actions, name)
}

/** Built-in workflows reserved for tasks delegated by leads. */
export const LEAD_ONLY_WORKFLOWS: readonly string[] = ['task', 'task-pr']
