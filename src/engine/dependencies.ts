import type { AgentExecutor } from '../executors/cli.ts'
import type { TicketDetail } from '../store/tickets.ts'
import type { RunnerOptions } from './runner.ts'
import { prepareDependencies } from '../workspace/dependencies.ts'

export async function dependencySession(
  options: RunnerOptions,
  detail: TicketDetail,
  signal: AbortSignal,
) {
  if (options.preparedSession) return options.preparedSession
  const dependencies = await prepareDependencies(
    options.workspaces,
    detail.ticket,
    detail.dependencies,
    signal,
  )
  const execute: AgentExecutor = async (invocation) => {
    try {
      await options.execute(invocation)
    } finally {
      await dependencies.verify()
    }
  }
  return { dependencies: dependencies.checkouts, execute }
}
