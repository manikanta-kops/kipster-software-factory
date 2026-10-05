import {
  APIError,
  APITimeoutError,
  APIConnectionError,
  TypeSafeClient,
  choice,
  type TypeSafeClientConfig,
} from '@typesafe-ai/sdk'
import { z } from 'zod'
import type { DecisionFacts, ModelDecision } from '../domain/decisions.ts'

export const DECISION_MODEL = 'jev-1.13.0'
const probability = z.number().min(0).max(1)
const responseSchema = z.object({
  model: z.string().min(1),
  answers: z.object({
    decision: z.object({
      type: z.literal('choice'),
      choice: z.string(),
      confidence: probability,
      probabilities: z.record(z.string(), probability),
    }),
  }),
  usage: z.object({
    input_tokens: z.int().nonnegative(),
    output_tokens: z.int().nonnegative(),
  }),
})
export type DecisionTransport = Pick<
  TypeSafeClientConfig,
  'baseURL' | 'fetch' | 'timeout' | 'retry'
>
function client(apiKey: string, transport: DecisionTransport = {}) {
  if (!apiKey.trim()) throw new Error('Empty TypeSafe key')
  return new TypeSafeClient({
    ...transport,
    apiKey,
    baseURL: transport.baseURL ?? 'https://api.typesafe.ai',
    defaultModel: DECISION_MODEL,
    logLevel: 'off',
    timeout: transport.timeout ?? 10_000,
  })
}
export async function validateTypeSafeKey(
  apiKey: string,
  transport?: DecisionTransport,
): Promise<void> {
  try {
    await client(apiKey, transport).models.list()
  } catch (error) {
    // Remote errors can contain credentials; keep their cause out of diagnostics.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(typeSafeError(error))
  }
}
export async function askTypeSafe(
  apiKey: string,
  facts: DecisionFacts,
  question: string,
  options: Readonly<Record<string, string>>,
  signal: AbortSignal,
  transport?: DecisionTransport,
): Promise<ModelDecision> {
  const response = responseSchema.parse(
    await client(apiKey, transport).systemOne(
      {
        state: JSON.parse(JSON.stringify(facts)),
        model: DECISION_MODEL,
        questions: { decision: choice(question, { ...options }) },
      },
      { signal },
    ),
  )
  const answer = response.answers.decision
  const keys = Object.keys(options)
  if (
    !Object.hasOwn(options, answer.choice) ||
    keys.length !== Object.keys(answer.probabilities).length ||
    keys.some((key) => !Object.hasOwn(answer.probabilities, key)) ||
    Math.abs(
      Object.values(answer.probabilities).reduce((a, b) => a + b, 0) - 1,
    ) > 0.01 ||
    Object.values(answer.probabilities).some(
      (p) => p > answer.probabilities[answer.choice]!,
    )
  )
    throw new Error('Invalid TypeSafe choice response')
  return {
    model: response.model,
    ...answer,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  }
}
export function typeSafeError(error: unknown): string {
  // Remote errors may echo credentials or request bodies; only known error categories cross this boundary.
  if (error instanceof APIError)
    return `TypeSafe HTTP ${error.status}: ${({ 401: 'invalid key', 422: 'invalid request', 429: 'rate limit after retries', 529: 'overloaded after retries' } as Record<number, string>)[error.status] ?? 'request failed after retries'}`
  if (error instanceof APITimeoutError) return 'TypeSafe timeout after retries'
  if (error instanceof APIConnectionError)
    return 'TypeSafe connection failed after retries'
  return 'TypeSafe returned an invalid response or could not complete the request'
}
