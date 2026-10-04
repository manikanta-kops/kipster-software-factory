import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import {
  type ActionName,
  actions,
  CAPABILITIES,
  EXITS,
  humanContract,
  isAction,
  isRole,
  LIMIT,
  NEEDS_DECISION,
  type RoleName,
  roles,
  type StepContract,
} from './catalog.ts'

export type Capability = (typeof CAPABILITIES)[number]

interface StepBase {
  readonly id: string
  readonly instructions?: string
  /** Outcome (or `limit`) to a step id or an exit. Unrouted outcomes use the defaults in routing.ts. */
  readonly routes: Readonly<Record<string, string>>
  /** How many times this step may send the ticket back before the `limit` route applies. */
  readonly limit?: number
}

export interface AgentStep extends StepBase {
  readonly kind: 'agent'
  readonly role: RoleName
  readonly needs: readonly Capability[]
}

export interface HumanStep extends StepBase {
  readonly kind: 'human'
}

export interface SystemStep extends StepBase {
  readonly kind: 'system'
  readonly action: ActionName
  readonly with: Readonly<Record<string, unknown>>
  readonly needs: readonly Capability[]
}

export type Step = AgentStep | HumanStep | SystemStep

export interface Workflow {
  readonly name: string
  readonly description: string
  readonly steps: readonly Step[]
}

export type ParseResult =
  | { readonly ok: true; readonly workflow: Workflow }
  | { readonly ok: false; readonly errors: readonly string[] }

const slug = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, 'use lowercase letters, digits and hyphens')

const rawStep = z.strictObject({
  id: slug,
  kind: z.enum(['agent', 'human', 'system']),
  role: z.string().optional(),
  action: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
  needs: z.array(z.string()).optional(),
  instructions: z.string().min(1).optional(),
  routes: z.record(z.string(), z.string()).optional(),
  limit: z.int().positive().optional(),
})

const rawWorkflow = z.strictObject({
  name: slug,
  description: z.string().min(1),
  steps: z.array(rawStep).min(1),
})

type RawStep = z.infer<typeof rawStep>

export function stepContract(step: Step): StepContract {
  switch (step.kind) {
    case 'agent':
      return roles[step.role]
    case 'human':
      return humanContract
    case 'system':
      return actions[step.action].contract(step.with)
  }
}

/** Every key a step may use in `routes`. */
export function routeKeys(step: Step): readonly string[] {
  const keys = [...stepContract(step).outcomes]
  if (step.kind !== 'human') keys.push(NEEDS_DECISION)
  if (step.limit !== undefined) keys.push(LIMIT)
  return keys
}

export function parseWorkflow(source: string): ParseResult {
  let document: unknown
  try {
    document = parseYaml(source)
  } catch (error) {
    return { ok: false, errors: [`not valid YAML: ${message(error)}`] }
  }

  const shape = rawWorkflow.safeParse(document)
  if (!shape.success) {
    return {
      ok: false,
      errors: shape.error.issues.map(
        (issue) => `${issue.path.join('.') || 'workflow'}: ${issue.message}`,
      ),
    }
  }

  const errors: string[] = []
  const steps: Step[] = []
  const ids = new Set<string>()
  for (const raw of shape.data.steps) {
    if (ids.has(raw.id)) errors.push(`step "${raw.id}": id is used twice`)
    if ((EXITS as readonly string[]).includes(raw.id)) {
      errors.push(
        `step "${raw.id}": id is reserved for an exit (${EXITS.join(', ')})`,
      )
    }
    ids.add(raw.id)
    const step = buildStep(raw, errors)
    if (step) steps.push(step)
  }

  for (const step of steps) checkRoutes(step, ids, errors)

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    workflow: {
      name: shape.data.name,
      description: shape.data.description,
      steps,
    },
  }
}

function buildStep(raw: RawStep, errors: string[]): Step | undefined {
  const at = `step "${raw.id}"`
  const base = {
    id: raw.id,
    routes: raw.routes ?? {},
    ...(raw.instructions === undefined
      ? {}
      : { instructions: raw.instructions }),
    ...(raw.limit === undefined ? {} : { limit: raw.limit }),
  }
  const needs = checkNeeds(raw, errors)

  switch (raw.kind) {
    case 'agent': {
      if (raw.action !== undefined || raw.with !== undefined) {
        errors.push(`${at}: agent steps take a role, not an action`)
      }
      if (raw.role === undefined || !isRole(raw.role)) {
        errors.push(
          `${at}: role must be one of ${Object.keys(roles).join(', ')}`,
        )
        return undefined
      }
      return { ...base, kind: 'agent', role: raw.role, needs }
    }
    case 'human': {
      if (
        raw.role !== undefined ||
        raw.action !== undefined ||
        raw.with !== undefined ||
        raw.needs !== undefined
      ) {
        errors.push(
          `${at}: human steps take no role, action, parameters or capabilities`,
        )
      }
      return { ...base, kind: 'human' }
    }
    case 'system': {
      if (raw.role !== undefined) {
        errors.push(`${at}: system steps take an action, not a role`)
      }
      if (raw.action === undefined || !isAction(raw.action)) {
        errors.push(
          `${at}: action must be one of ${Object.keys(actions).join(', ')}`,
        )
        return undefined
      }
      const params = actions[raw.action].params.safeParse(raw.with ?? {})
      if (!params.success) {
        for (const issue of params.error.issues) {
          errors.push(
            `${at}: with.${issue.path.join('.') || '(root)'}: ${issue.message}`,
          )
        }
        return undefined
      }
      return {
        ...base,
        kind: 'system',
        action: raw.action,
        with: params.data as Record<string, unknown>,
        needs,
      }
    }
  }
}

function checkNeeds(raw: RawStep, errors: string[]): Capability[] {
  const needs: Capability[] = []
  for (const need of raw.needs ?? []) {
    if ((CAPABILITIES as readonly string[]).includes(need)) {
      needs.push(need as Capability)
    } else {
      errors.push(
        `step "${raw.id}": unknown capability "${need}" (known: ${CAPABILITIES.join(', ')})`,
      )
    }
  }
  return needs
}

function checkRoutes(step: Step, ids: Set<string>, errors: string[]) {
  const at = `step "${step.id}"`
  const keys = routeKeys(step)
  for (const [key, target] of Object.entries(step.routes)) {
    if (key === LIMIT && step.limit === undefined) {
      errors.push(`${at}: a "limit" route needs a limit on the step`)
    } else if (!keys.includes(key)) {
      errors.push(
        `${at}: cannot route "${key}"; this step can report ${keys.join(', ')}`,
      )
    }
    if (!ids.has(target) && !(EXITS as readonly string[]).includes(target)) {
      errors.push(
        `${at}: route "${key}" goes to unknown step "${target}" (exits: ${EXITS.join(', ')})`,
      )
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
