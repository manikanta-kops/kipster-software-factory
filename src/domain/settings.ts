import { z } from 'zod'
import {
  AGENT_CLIS,
  type AgentChoice,
  EFFORTS,
  type RoleName,
  roles,
} from './catalog.ts'

export const ROLE_NAMES = Object.keys(roles) as RoleName[]
export const DEFAULT_CONCURRENCY = 2
export const DEFAULT_STEP_TIMEOUT_MINUTES = 120
export const DEFAULT_AGENT: AgentChoice = { cli: 'codex' }

export const agentSettingSchema = z.strictObject({
  cli: z.enum(AGENT_CLIS, {
    error: `unknown CLI; use ${AGENT_CLIS.join(' or ')}`,
  }),
  model: z
    .string()
    .trim()
    .min(1, { error: 'enter a model or leave it out' })
    .optional(),
  effort: z
    .enum(EFFORTS, { error: `unknown effort; use ${EFFORTS.join(', ')}` })
    .optional(),
})

export const roleAgentsSchema = z.partialRecord(
  z.enum(ROLE_NAMES, { error: 'unknown role' }),
  agentSettingSchema,
)

export const concurrencySchema = z
  .int({
    error: 'must be a positive integer',
  })
  .positive({ error: 'must be a positive integer' })

export const timeoutSchema = z
  .number({ error: 'must be a positive number of minutes' })
  .positive({ error: 'must be a positive number of minutes' })

export const workflowOverrideSchema = z.strictObject({
  stepTimeoutMinutes: timeoutSchema.optional(),
  roles: roleAgentsSchema.optional(),
})
export type WorkflowOverride = z.infer<typeof workflowOverrideSchema>

/** The engine settings the owner edits while the factory runs. */
export const settingsSchema = z.strictObject({
  concurrency: concurrencySchema,
  stepTimeoutMinutes: timeoutSchema,
  agents: z.strictObject({
    default: agentSettingSchema,
    roles: roleAgentsSchema,
    /** The agents a lead may choose for a task. Empty: tasks use the role settings. */
    allowed: z.array(agentSettingSchema),
  }),
  /** Overrides for one workflow, keyed by workflow name. */
  workflows: z.record(z.string().min(1), workflowOverrideSchema),
})
export type Settings = z.infer<typeof settingsSchema>

export const DEFAULT_SETTINGS: Settings = {
  concurrency: DEFAULT_CONCURRENCY,
  stepTimeoutMinutes: DEFAULT_STEP_TIMEOUT_MINUTES,
  agents: { default: DEFAULT_AGENT, roles: {}, allowed: [] },
  workflows: {},
}

/**
 * The agent for one step: a lead's task agent sets only the builder, so review can come
 * from another model family; then the workflow override, the role setting and the default.
 */
export function resolveAgent(
  settings: Pick<Settings, 'agents'> & Partial<Pick<Settings, 'workflows'>>,
  {
    workflow,
    role,
    taskAgent,
  }: {
    readonly workflow: string
    readonly role: RoleName
    readonly taskAgent?: AgentChoice | null | undefined
  },
): AgentChoice {
  if (role === 'builder' && taskAgent) return taskAgent
  return (
    settings.workflows?.[workflow]?.roles?.[role] ??
    settings.agents.roles[role] ??
    settings.agents.default
  )
}

export function stepTimeoutFor(
  settings: Pick<Settings, 'stepTimeoutMinutes'> &
    Partial<Pick<Settings, 'workflows'>>,
  workflow: string,
): number {
  return (
    settings.workflows?.[workflow]?.stepTimeoutMinutes ??
    settings.stepTimeoutMinutes
  )
}

/** Problems zod cannot see: overrides must name a workflow in the library. */
export function settingsProblems(
  settings: Settings,
  workflows: readonly string[],
): string[] {
  return Object.keys(settings.workflows)
    .filter((name) => !workflows.includes(name))
    .map((name) => `workflows.${name}: unknown workflow`)
}

/** `claude · claude-opus-5-5 · medium` */
export function describeAgent(agent: AgentChoice): string {
  return [agent.cli, agent.model, agent.effort].filter(Boolean).join(' · ')
}
