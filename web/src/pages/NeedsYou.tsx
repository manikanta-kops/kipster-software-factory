import { Lessons } from '../components/Lessons.tsx'
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
  // Children included: a waiting child's gate decides whether its lead needs you.
  const waiting = all.filter((ticket) => ticket.status === 'needs-you')
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
  if (query.isPending) return <p className="muted">Loading tickets…</p>
  if (query.isError) return <ErrorMessage error={query.error} />
  const waitsForOwner = (ticket: ListedTicket) =>
    ticket.status === 'needs-you' && !factoryMerges.has(ticket.number)
  const tasksOf = new Map<number, ListedTicket[]>()
  for (const ticket of all)
    if (ticket.task)
      tasksOf.set(ticket.task.leadNumber, [
        ...(tasksOf.get(ticket.task.leadNumber) ?? []),
        ticket,
      ])
  const waitingTasksOf = (ticket: ListedTicket) =>
    (tasksOf.get(ticket.number) ?? []).filter(waitsForOwner)
  const ended = (ticket: ListedTicket) =>
    ['done', 'cancelled'].includes(ticket.status)
  // Only owner tickets get rows; a lead's tasks fold under it.
  const visible = all.filter(
    (ticket) => !ticket.task && matches(filter, ticket),
  )
  const needsYou = visible.filter((ticket) =>
    ended(ticket)
      ? ticket.summary?.status === 'needs-you' &&
        now - Date.parse(ticket.updatedAt) < 24 * 60 * 60 * 1000
      : waitsForOwner(ticket) || waitingTasksOf(ticket).length > 0,
  )
  const moving = visible
    .filter(
      (ticket) =>
        !needsYou.includes(ticket) &&
        (['queued', 'running'].includes(ticket.status) ||
          factoryMerges.has(ticket.number)),
    )
    .sort(
      (a, b) => Number(a.status === 'queued') - Number(b.status === 'queued'),
    )
  const workflowOf = (ticket: ListedTicket) =>
    workflows.data?.workflows.find((item) => item.name === ticket.workflow.name)
  const finished = visible.filter(
    (ticket) => ended(ticket) && !needsYou.includes(ticket),
  )
  const fold = (ticket: ListedTicket) => {
    const tasks = tasksOf.get(ticket.number)
    return tasks ? (
      <TaskFold
        tasks={tasks}
        workflowOf={workflowOf}
        factoryMerges={factoryMerges}
        now={now}
      />
    ) : null
  }
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
      <Lessons status="proposed" repositories={filter.repositories} />
      {needsYou.length === 0 && moving.length === 0 && !scope ? (
        <EmptyFactory
          hasRepositories={repositories.data?.repositories.length !== 0}
        />
      ) : (
        <>
          <section className="needs" aria-label="Needs you">
            {needsYou.length ? (
              <>
                <h2 className="section-title attention">
                  <i aria-hidden="true" />
                  Needs you
                </h2>
                {needsYou.map((ticket, index) => {
                  const waitingTasks = waitingTasksOf(ticket)
                  const focus =
                    ticket.status !== 'needs-you' && waitingTasks.length === 1
                      ? waitingTasks[0]!
                      : ticket
                  return (
                    <DecisionCard
                      key={ticket.id}
                      ticket={ticket}
                      focus={focus}
                      waitingTasks={waitingTasks}
                      detail={detailByNumber.get(focus.number)}
                      now={now}
                      index={index}
                    >
                      {fold(ticket)}
                    </DecisionCard>
                  )
                })}
              </>
            ) : (
              <h2 className="all-clear">
                <span className="all-clear-mark" aria-hidden="true">
                  <Icon name="check" size={11} stroke={2.6} />
                </span>
                Nothing{scope} needs you.
              </h2>
            )}
          </section>
          {moving.length > 0 && (
            <section className="moving" aria-labelledby="moving-heading">
              <h2 className="section-title" id="moving-heading">
                Moving
              </h2>
              <ul className="rows">
                {moving.map((ticket) => {
                  const tasks = fold(ticket)
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
                    <li className="lead-group" key={ticket.id}>
                      {row}
                      {tasks}
                    </li>
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
                  <span className="finished-main">
                    <span className="finished-title">{ticket.title}</span>
                    {ticket.summary && (
                      <span className="finished-happened">
                        {ticket.summary.happened}
                      </span>
                    )}
                  </span>
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
  focus,
  waitingTasks,
  detail,
  now,
  index,
  children,
}: {
  ticket: ListedTicket
  /** The ticket the owner acts on: the lead itself, or its one waiting task. */
  focus: ListedTicket
  waitingTasks: readonly ListedTicket[]
  detail: TicketResponse | undefined
  now: number
  index: number
  children: ReactNode
}) {
  const waiting = focus.waiting
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
  const question =
    focus !== ticket
      ? `Task ${focus.task?.key}: ${attention(focus)}`
      : ticket.status !== 'needs-you' && waitingTasks.length > 1
        ? `${waitingTasks.length} tasks need you`
        : ticket.status !== 'needs-you' && ticket.summary?.actions[0]
          ? ticket.summary.actions[0].label
          : attention(ticket)
  // A running lead's stored summary is stale; its waiting tasks are the count.
  const live = ['queued', 'running'].includes(ticket.status)
  const status =
    ticket.summary && !live
      ? ticket.summary
      : waitingTasks.length
        ? { status: 'needs-you' as const, needsYouCount: waitingTasks.length }
        : null
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
          {status && <SummaryStatus summary={status} />}
          <RepositoryTag repository={ticket.repository} />
          {waiting && <span>waiting {since(waiting.since, now)}</span>}
        </p>
        <h3 id={`decision-${ticket.id}`}>
          <a href={`#/tickets/${ticket.number}`}>{ticket.title}</a>
        </h3>
        <p className="decision-question">{question}</p>
        {waiting?.summary && (
          <p className="decision-context">{waiting.summary}</p>
        )}
        {plan && <p className="decision-context">{plan}</p>}
        {ticket.summary && !live && (
          <p className="decision-happened summary-happened">
            {ticket.summary.happened}
          </p>
        )}
      </div>
      {image && (
        <a
          className="decision-thumb"
          href={`#/tickets/${focus.number}`}
          aria-label={`Open ${image.title}`}
        >
          <img src={api.artifactUrl(image.id)} alt="" loading="lazy" />
        </a>
      )}
      <div className="decision-actions">
        <a className="button primary" href={`#/tickets/${focus.number}`}>
          {action}
        </a>
        <PullRequest
          url={
            waiting?.for === 'pull-request-merge' ? focus.pullRequestUrl : null
          }
        />
      </div>
      {children && <div className="decision-tasks">{children}</div>}
    </article>
  )
}

type TaskState = 'done' | 'now' | 'you' | 'queued' | 'stopped' | 'replaced'

/** A lead's child tickets folded under its row, so one piece of work reads as one. */
function TaskFold({
  tasks,
  workflowOf,
  factoryMerges,
  now,
}: {
  tasks: readonly ListedTicket[]
  workflowOf: (ticket: ListedTicket) => WorkflowSummary | undefined
  factoryMerges: ReadonlySet<number>
  now: number
}) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const state = (ticket: ListedTicket): TaskState =>
    ticket.task?.replacedBy
      ? 'replaced'
      : ticket.status === 'needs-you' && !factoryMerges.has(ticket.number)
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
            replaced: 'Replaced',
          }[value]
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const running = tasks.filter(
    (ticket) =>
      ['queued', 'running'].includes(ticket.status) ||
      factoryMerges.has(ticket.number),
  )
  return (
    <>
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
                    {ticket.task?.replacedBy
                      ? `Replaced by #${ticket.task.replacedBy}`
                      : state(ticket) === 'you'
                        ? 'Needs you'
                        : humanize(ticket.status)}
                  </span>
                </a>
              </li>
            ))}
        </ul>
      )}
    </>
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
            {factoryMerge && ticket.summary && (
              <SummaryStatus summary={ticket.summary} />
            )}
            <span className="row-doing">
              {factoryMerge ? 'Factory merge pending' : doing(ticket, step)}
            </span>
            <span className="muted">{since(ticket.updatedAt, now)}</span>
            {factoryMerge && ticket.summary && (
              <span className="row-happened summary-happened">
                {ticket.summary.happened}
              </span>
            )}
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
