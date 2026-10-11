import type {
  Attempt,
  TicketResponse,
  UsageTotals,
} from '../../../src/api/contract.ts'
import {
  compactDuration,
  compactNumber,
  isFinishedRun,
  runDuration,
} from '../../../src/domain/usage.ts'
import { agentLabel, humanize, stepName } from '../words.ts'
import { Icon } from './Icon.tsx'

/** What each finished step run cost in tokens and time, collapsed by default. */
export function Usage({ detail }: { detail: TicketResponse }) {
  const runs = detail.attempts.filter(isFinishedRun)
  const tasks = detail.usage?.tasks ?? []
  if (!detail.usage || (!runs.length && !tasks.length)) return null
  const rounds = new Map<string, number>()
  const counts = new Map<string, number>()
  for (const run of runs)
    counts.set(run.stepId, (counts.get(run.stepId) ?? 0) + 1)
  return (
    <section className="steps-card usage-card" aria-label="Usage">
      <details className="usage">
        <summary>
          <Icon name="chevronRight" size={12} stroke={2} />
          <span className="usage-title">Usage</span>
          <span className="usage-totals">{totals(detail.usage.total)}</span>
        </summary>
        <div className="usage-table">
          <table>
            <thead>
              <tr>
                <th scope="col">Step</th>
                <th scope="col">Agent</th>
                <th scope="col">Outcome</th>
                <th scope="col" className="number">
                  Input
                </th>
                <th scope="col" className="number">
                  Output
                </th>
                <th scope="col" className="number">
                  Time
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const round = (rounds.get(run.stepId) ?? 0) + 1
                rounds.set(run.stepId, round)
                return (
                  <tr key={run.id}>
                    <td>
                      {name(detail, run)}
                      {counts.get(run.stepId)! > 1 && (
                        <span className="usage-round"> round {round}</span>
                      )}
                    </td>
                    <td className="usage-agent">
                      {run.agent ? agentLabel(run.agent) : run.executor}
                    </td>
                    <td>{run.outcome ?? run.status}</td>
                    <td className="number">{tokens(run.inputTokens)}</td>
                    <td className="number">{tokens(run.outputTokens)}</td>
                    <td className="number">
                      {compactDuration(runDuration(run)!)}
                    </td>
                  </tr>
                )
              })}
              {tasks.map((task) => (
                <tr key={`task-${task.taskId}`} className="usage-task">
                  <td>
                    Task{' '}
                    <a
                      className="text-link"
                      href={`#/tickets/${task.ticketNumber}`}
                    >
                      {task.key} #{task.ticketNumber}
                    </a>
                  </td>
                  <td>
                    {task.usage.steps} step{' '}
                    {task.usage.steps === 1 ? 'run' : 'runs'}
                  </td>
                  <td>{task.status}</td>
                  <td className="number">{tokens(task.usage.inputTokens)}</td>
                  <td className="number">{tokens(task.usage.outputTokens)}</td>
                  <td className="number">
                    {compactDuration(task.usage.durationMs)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  )
}

function totals(total: UsageTotals) {
  const parts = ['']
  if (total.inputTokens !== null || total.outputTokens !== null)
    parts.push(`↑${tokens(total.inputTokens)} ↓${tokens(total.outputTokens)}`)
  parts.push(compactDuration(total.durationMs))
  return parts.join(' · ')
}

function tokens(value: number | null) {
  return value === null ? '—' : compactNumber(value)
}

function name(detail: TicketResponse, run: Attempt) {
  const step = detail.workflow.steps.find((s) => s.id === run.stepId)
  return step ? stepName(step) : humanize(run.stepId)
}
