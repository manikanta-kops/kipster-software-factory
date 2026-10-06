import { SummaryStatus } from '../components/TicketSummary.tsx'
import {
  useEffect,
  useId,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import type {
  ListedTicket,
  TicketResponse,
  WorkflowSummary,
} from '../../../src/api/contract.ts'
import { mergePolicy } from '../../../src/domain/auto-merge.ts'
import { api } from '../api.ts'
import { attention, ErrorMessage, PullRequest } from '../components/Shared.tsx'
import {
  describeFilter,
  FilterMenu,
  isFiltered,
  matches,
  RepositoryTag,
  type TicketFilter,
} from '../components/Filters.tsx'
import { Building } from '../components/Building.tsx'
import { Icon, stepHue, stepIcon } from '../components/Icon.tsx'
import {
  repositoriesQuery,
  ticketQuery,
  ticketsQuery,
  workflowsQuery,
} from '../queries.ts'
import { doing, greeting, humanize, repositoryTone, since } from '../words.ts'

/** Re-render on a slow clock so relative times stay true. */
function useNow(interval = 30_000) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval)
    return () => clearInterval(timer)
  }, [interval])
  return now
}

export function NeedsYou({
  filter,
  onFilter,
}: {
  filter: TicketFilter
  onFilter: (filter: TicketFilter) => void
}) {
  const query = useQuery(ticketsQuery)
  const workflows = useQuery(workflowsQuery)
  const repositories = useQuery(repositoriesQuery)
  const now = useNow()
  const all = query.data?.tickets ?? []
  const waiting = all.filter(
    (ticket) => ticket.status === 'needs-you' && matches(filter, ticket),
  )
  const details = useQueries({
    queries: waiting.map((ticket) => ticketQuery(ticket.number)),
  })
  const detailByNumber = new Map(
    waiting.map((ticket, index) => [ticket.number, details[index]?.data]),
  )
  const factoryMerges = new Set(
    waiting
      .filter((ticket) => {
        const gate = detailByNumber.get(ticket.number)?.mergeGate?.latest
        const enabled = repositories.data?.repositories.find(
          (repository) => repository.id === ticket.repository.id,
        )?.autoMerge
        return (
          ticket.waiting?.for === 'pull-request-merge' &&
          !!gate &&
          mergePolicy(!!enabled, gate) === 'merge'
        )
      })
      .map((ticket) => ticket.number),
  )
  const needsYou = waiting.filter((ticket) => !factoryMerges.has(ticket.number))
  if (query.isPending) return <p className="muted">Loading tickets…</p>
  if (query.isError) return <ErrorMessage error={query.error} />
  const visible = all.filter((ticket) => matches(filter, ticket))
  const moving = visible
    .filter(
      (ticket) =>
        ['queued', 'running'].includes(ticket.status) ||
        factoryMerges.has(ticket.number),
    )
    .sort(
      (a, b) => Number(a.status === 'queued') - Number(b.status === 'queued'),
    )
  const leads = new Set(moving.map((ticket) => ticket.number))
  const tasksOf = new Map<number, ListedTicket[]>()
  for (const ticket of visible)
    if (ticket.task && leads.has(ticket.task.leadNumber))
      tasksOf.set(ticket.task.leadNumber, [
        ...(tasksOf.get(ticket.task.leadNumber) ?? []),
        ticket,
      ])
  const topMoving = moving.filter(
    (ticket) => !(ticket.task && leads.has(ticket.task.leadNumber)),
  )
  const workflowOf = (ticket: ListedTicket) =>
    workflows.data?.workflows.find((item) => item.name === ticket.workflow.name)
  const finished = visible.filter((ticket) =>
    ['done', 'cancelled'].includes(ticket.status),
  )
  const summarized = visible.filter(
    (ticket) =>
      ticket.summary &&
      (needsYou.some((item) => item.id === ticket.id) ||
        (['done', 'cancelled'].includes(ticket.status) &&
          now - Date.parse(ticket.updatedAt) < 24 * 60 * 60 * 1000)),
  )
  const summaryIds = new Set(summarized.map((ticket) => ticket.id))
  const scope = isFiltered(filter) ? ` in ${describeFilter(filter)}` : ''
  const repositoryRefs = [
    ...new Map(
      [
        ...(repositories.data?.repositories ?? []),
        ...all.map((ticket) => ticket.repository),
      ].map((item) => [item.slug, { id: item.id, slug: item.slug }]),
    ).values(),
  ]
  const order = workflows.data?.workflows.map((item) => item.name) ?? []
  const workflowNames = [
    ...new Set(all.map((ticket) => ticket.workflow.name)),
  ].sort((a, b) => order.indexOf(a) - order.indexOf(b))
  return (
    <div className="home-page">
      <header className="masthead">
        <p className="date">
          {new Date(now).toLocaleDateString(undefined, {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
          })}
        </p>
        <h1 className="greeting">{greeting(new Date(now))}.</h1>
        <FilterMenu
          filter={filter}
          repositories={repositoryRefs}
          workflows={workflowNames}
          onChange={onFilter}
        />
      </header>
      {summarized.length > 0 && (
        <section className="today-summaries" aria-label="Ticket summaries">
          <h2 className="section-title">Ticket summaries</h2>
          <ul>
            {summarized.map((ticket) => (
              <li className="today-summary" key={ticket.id}>
                <SummaryStatus summary={ticket.summary!} />
                <a
                  className="summary-title"
                  href={`#/tickets/${ticket.number}`}
                >
                  {ticket.title}
                </a>
                <span className="summary-happened">
                  {ticket.summary!.happened}
                </span>
                <a className="text-link" href={`#/tickets/${ticket.number}`}>
                  View details
                  <span className="sr-only"> for {ticket.title}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      {needsYou.length === 0 && moving.length === 0 && !scope ? (
        <EmptyFactory
          hasRepositories={repositories.data?.repositories.length !== 0}
        />
      ) : (
        <>
          <section className="needs" aria-label="Needs you">
            {needsYou.filter((ticket) => !summaryIds.has(ticket.id)).length ? (
              <>
                <h2 className="section-title attention">
                  <i aria-hidden="true" />
                  Needs you
                </h2>
                {needsYou
                  .filter((ticket) => !summaryIds.has(ticket.id))
                  .map((ticket, index) => (
                    <DecisionCard
                      key={ticket.id}
                      ticket={ticket}
                      detail={detailByNumber.get(ticket.number)}
                      now={now}
                      index={index}
                    />
                  ))}
              </>
            ) : needsYou.length === 0 ? (
              <h2 className="all-clear">
                <span className="all-clear-mark" aria-hidden="true">
                  <Icon name="check" size={11} stroke={2.6} />
                </span>
                Nothing{scope} needs you.
              </h2>
            ) : null}
          </section>
          {moving.length > 0 && (
            <section className="moving" aria-labelledby="moving-heading">
              <h2 className="section-title" id="moving-heading">
                Moving
              </h2>
              <ul className="rows">
                {topMoving.map((ticket) => {
                  const tasks = tasksOf.get(ticket.number)
                  const row = (
                    <MovingRow
                      key={ticket.id}
                      ticket={ticket}
                      factoryMerge={factoryMerges.has(ticket.number)}
                      workflow={workflowOf(ticket)}
                      now={now}
                    />
                  )
                  return tasks ? (
                    <LeadGroup
                      key={ticket.id}
                      tasks={tasks}
                      moving={moving}
                      needsYou={needsYou}
                      workflowOf={workflowOf}
                      factoryMerges={factoryMerges}
                      now={now}
                    >
                      {row}
                    </LeadGroup>
                  ) : (
                    row
                  )
                })}
              </ul>
            </section>
          )}
        </>
      )}
      {finished.length > 0 && (
        <details className="finished">
          <summary>
            <Icon name="chevronRight" size={12} stroke={2.2} />
            Show finished ({finished.length})
          </summary>
          <ul className="finished-list">
            {finished.map((ticket) => (
              <li key={ticket.id}>
                <a href={`#/tickets/${ticket.number}`}>
                  <span className={`finished-mark ${ticket.status}`}>
                    <Icon
                      name={ticket.status === 'cancelled' ? 'x' : 'check'}
                      size={11}
                      stroke={2.4}
                    />
                  </span>
                  <span className="finished-title">{ticket.title}</span>
                  <RepositoryTag repository={ticket.repository} />
                  <span className="muted">
                    {ticket.status === 'cancelled' ? 'Cancelled' : 'Done'}{' '}
                    {since(ticket.updatedAt, now)} ago
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function EmptyFactory({ hasRepositories }: { hasRepositories: boolean }) {
  return (
    <section className="empty-state" aria-labelledby="empty-heading">
      <Building />
      <h2 id="empty-heading">
        {hasRepositories ? 'Ready to build' : 'Add a repository to start'}
      </h2>
      <p>
        {hasRepositories
          ? 'Describe a change. Kipster plans it, builds it and proves it in a pull request.'
          : 'Kipster turns tickets into pull requests in a repository you add.'}
      </p>
      <a
        className="button primary"
        href={hasRepositories ? '#/tickets/new' : '#/repositories'}
      >
        {hasRepositories ? 'Start a ticket' : 'Add a repository'}
      </a>
    </section>
  )
}

function lastImage(detail: TicketResponse | undefined) {
  return detail?.artifacts.findLast(
    (artifact) =>
      artifact.content === null && artifact.mediaType.startsWith('image/'),
  )
}
function planSummary(detail: TicketResponse | undefined) {
  const plan = detail?.artifacts.findLast((item) => item.kind === 'plan')
  return plan
    ? detail?.attempts.find((attempt) => attempt.id === plan.attemptId)?.summary
    : undefined
}

function DecisionCard({
  ticket,
  detail,
  now,
  index,
}: {
  ticket: ListedTicket
  detail: TicketResponse | undefined
  now: number
  index: number
}) {
  const waiting = ticket.waiting
  const image = lastImage(detail)
  const plan = waiting?.for === 'human' ? planSummary(detail) : undefined
  const action =
    waiting?.for === 'human'
      ? waiting.stepId.includes('plan')
        ? 'Read the plan'
        : 'Review'
      : waiting?.for === 'ask'
        ? 'Decide'
        : 'Open ticket'
  return (
    <article
      className="decision"
      style={
        {
          ...repositoryTone(ticket.repository.id),
          '--i': index,
        } as CSSProperties
      }
      aria-labelledby={`decision-${ticket.id}`}
    >
      <div className="decision-main">
        <p className="decision-meta">
          <RepositoryTag repository={ticket.repository} />
          {ticket.task && (
            <span>
              Task {ticket.task.key} of #{ticket.task.leadNumber}
            </span>
          )}
          {waiting && <span>waiting {since(waiting.since, now)}</span>}
        </p>
        <h3 id={`decision-${ticket.id}`}>
          <a href={`#/tickets/${ticket.number}`}>{ticket.title}</a>
        </h3>
        <p className="decision-question">{attention(ticket)}</p>
        {waiting?.summary && (
          <p className="decision-context">{waiting.summary}</p>
        )}
        {plan && <p className="decision-context">{plan}</p>}
      </div>
      {image && (
        <a
          className="decision-thumb"
          href={`#/tickets/${ticket.number}`}
          aria-label={`Open ${image.title}`}
        >
          <img src={api.artifactUrl(image.id)} alt="" loading="lazy" />
        </a>
      )}
      <div className="decision-actions">
        <a className="button primary" href={`#/tickets/${ticket.number}`}>
          {action}
        </a>
        <PullRequest
          url={
            waiting?.for === 'pull-request-merge' ? ticket.pullRequestUrl : null
          }
        />
      </div>
    </article>
  )
}

type TaskState = 'done' | 'now' | 'you' | 'queued' | 'stopped'

/** A lead's row with its child tickets folded underneath, so one piece of work reads as one. */
function LeadGroup({
  tasks,
  moving,
  needsYou,
  workflowOf,
  factoryMerges,
  now,
  children,
}: {
  tasks: readonly ListedTicket[]
  moving: readonly ListedTicket[]
  needsYou: readonly ListedTicket[]
  workflowOf: (ticket: ListedTicket) => WorkflowSummary | undefined
  factoryMerges: ReadonlySet<number>
  now: number
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const state = (ticket: ListedTicket): TaskState =>
    needsYou.includes(ticket)
      ? 'you'
      : ticket.status === 'done'
        ? 'done'
        : ticket.status === 'cancelled'
          ? 'stopped'
          : ticket.status === 'queued'
            ? 'queued'
            : 'now'
  const counts = new Map<string, number>()
  for (const ticket of tasks) {
    const value = state(ticket)
    const label =
      value === 'now'
        ? factoryMerges.has(ticket.number)
          ? 'Merging'
          : doing(
              ticket,
              workflowOf(ticket)?.steps.find(
                (step) => step.id === ticket.currentStep,
              ),
            )
        : {
            done: 'Done',
            you: 'Need you',
            queued: 'Queued',
            stopped: 'Cancelled',
          }[value]
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const running = tasks.filter((ticket) => moving.includes(ticket))
  return (
    <li className="lead-group">
      {children}
      <button
        type="button"
        className="lead-tasks-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
      >
        <Icon name="chevronRight" size={11} stroke={2.4} />
        <span className="lead-tasks-count">
          {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}
        </span>
        <span className="lead-tasks-summary">
          {[...counts].map(([label, count]) => `${count} ${label}`).join(' · ')}
        </span>
        <span className="task-bar" aria-hidden="true">
          {tasks.map((ticket) => (
            <i key={ticket.id} className={state(ticket)} />
          ))}
        </span>
      </button>
      {open && (
        <ul className="rows task-rows" id={panelId}>
          {running.map((ticket) => (
            <MovingRow
              key={ticket.id}
              ticket={ticket}
              factoryMerge={factoryMerges.has(ticket.number)}
              workflow={workflowOf(ticket)}
              now={now}
              nested
            />
          ))}
          {tasks
            .filter((ticket) => !running.includes(ticket))
            .map((ticket) => (
              <li key={ticket.id}>
                <a className="task-line" href={`#/tickets/${ticket.number}`}>
                  <span className={`task-dot ${state(ticket)}`} />
                  <span className="task-line-title">{ticket.title}</span>
                  <span className="muted">
                    {state(ticket) === 'you'
                      ? 'Needs you'
                      : humanize(ticket.status)}
                  </span>
                </a>
              </li>
            ))}
        </ul>
      )}
    </li>
  )
}

function MovingRow({
  ticket,
  factoryMerge,
  workflow,
  now,
  nested = false,
}: {
  ticket: ListedTicket
  factoryMerge: boolean
  workflow: WorkflowSummary | undefined
  now: number
  nested?: boolean
}) {
  const step = workflow?.steps.find((item) => item.id === ticket.currentStep)
  const at = workflow?.steps.findIndex((item) => item.id === ticket.currentStep)
  const queued = ticket.status === 'queued'
  return (
    <li>
      <a
        className={`row${queued ? ' queued' : ''}`}
        href={`#/tickets/${ticket.number}`}
      >
        <span className={`step-badge hue-${stepHue(step)}`}>
          <Icon name={queued ? 'clock' : stepIcon(step)} size={14} />
        </span>
        <span className="row-main">
          <span className="row-title">{ticket.title}</span>
          <span className="row-sub">
            {nested && ticket.task ? (
              <span className="task-key">{ticket.task.key}</span>
            ) : (
              <RepositoryTag repository={ticket.repository} />
            )}
            {!nested && ticket.task && (
              <span className="muted">
                Task {ticket.task.key} of #{ticket.task.leadNumber}
              </span>
            )}
            <span className="row-doing">
              {factoryMerge ? 'Factory merge pending' : doing(ticket, step)}
            </span>
            <span className="muted">{since(ticket.updatedAt, now)}</span>
          </span>
        </span>
        {workflow && at !== undefined && at >= 0 && (
          <>
            <span className="step-dots" aria-hidden="true">
              {workflow.steps.map((item, index) => (
                <i
                  key={item.id}
                  className={
                    index < at
                      ? 'done'
                      : index === at
                        ? queued
                          ? 'idle'
                          : 'now'
                        : ''
                  }
                />
              ))}
            </span>
            <span className="sr-only">
              Step {at + 1} of {workflow.steps.length}
            </span>
          </>
        )}
      </a>
    </li>
  )
}
