import type { AgentConfig } from '../config.ts'
import { run } from './process.ts'

export function cliCommand(config: AgentConfig): {
  command: string
  args: string[]
} {
  if (config.cli === 'codex')
    return {
      command: 'codex',
      args: [
        'exec',
        '--dangerously-bypass-approvals-and-sandbox',
        '--ephemeral',
        '--json',
        ...(config.model ? ['--model', config.model] : []),
        ...(config.effort
          ? ['-c', `model_reasoning_effort="${config.effort}"`]
          : []),
        '-',
      ],
    }
  return {
    command: 'claude',
    args: [
      '--print',
      '--dangerously-skip-permissions',
      '--no-session-persistence',
      '--output-format',
      'stream-json',
      '--verbose',
      ...(config.model ? ['--model', config.model] : []),
      ...(config.effort ? ['--effort', config.effort] : []),
    ],
  }
}
export interface AgentInvocation {
  config: AgentConfig
  cwd: string
  prompt: string
  directory: string
  log: string
  signal: AbortSignal
}
export type AgentExecutor = (invocation: AgentInvocation) => Promise<void>
export const executeAgent: AgentExecutor = async ({
  config,
  cwd,
  prompt,
  log,
  signal,
}) => {
  const { command, args } = cliCommand(config)
  await run(command, args, { cwd, input: prompt, log, signal })
}
