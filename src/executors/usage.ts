import { readFile } from 'node:fs/promises'
import type { AgentConfig } from '../config.ts'
import type { TokenUsage } from '../domain/usage.ts'

/**
 * Tokens one agent run reported in its JSON event stream, or null when it reported none.
 * Never estimates and never throws: unreadable lines are skipped.
 */
export function parseUsage(
  cli: AgentConfig['cli'],
  text: string,
): TokenUsage | null {
  let usage: TokenUsage | null = null
  for (const line of text.split('\n')) {
    const event = parseLine(line)
    if (!event || typeof event.usage !== 'object' || event.usage === null)
      continue
    const counts = event.usage as Record<string, unknown>
    const input = tokens(counts.input_tokens)
    const output = tokens(counts.output_tokens)
    if (input === null || output === null) continue
    if (cli === 'claude' && event.type === 'result')
      // Claude reports cached input apart from input_tokens; the run read all of it.
      usage = {
        inputTokens:
          input +
          (tokens(counts.cache_creation_input_tokens) ?? 0) +
          (tokens(counts.cache_read_input_tokens) ?? 0),
        outputTokens: output,
      }
    else if (cli === 'codex' && event.type === 'turn.completed')
      // Codex's input_tokens already includes cached_input_tokens.
      usage = add(usage, { inputTokens: input, outputTokens: output })
  }
  return usage
}

/** Reads a session log after its run; a missing or unreadable log has no usage. */
export async function readUsage(
  cli: AgentConfig['cli'],
  log: string,
): Promise<TokenUsage | null> {
  try {
    return parseUsage(cli, await readFile(log, 'utf8'))
  } catch {
    return null
  }
}

function parseLine(line: string): Record<string, unknown> | null {
  if (!line.trimStart().startsWith('{') || !line.includes('"usage"'))
    return null
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function add(a: TokenUsage | null, b: TokenUsage): TokenUsage {
  return a
    ? {
        inputTokens: a.inputTokens + b.inputTokens,
        outputTokens: a.outputTokens + b.outputTokens,
      }
    : b
}

function tokens(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null
}
