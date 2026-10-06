import { useEffect, useState, type CSSProperties } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import type {
  Ticket,
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
import { Icon, stepHue, stepIcon } from '../components/Icon.tsx'
import {
  repositoriesQuery,
  ticketQuery,
  ticketsQuery,
  workflowsQuery,
} from '../queries.ts'
import { doing, greeting, repositoryTone, since } from '../words.ts'

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
  const finished = visible.filter((ticket) =>
    ['done', 'cancelled'].includes(ticket.status),
  )
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
      <section className="needs" aria-label="Needs you">
        {needsYou.length ? (
          <>
            <h2 className="section-title attention">
              <i aria-hidden="true" />
              Needs you
            </h2>
            {needsYou.map((ticket) => (
              <DecisionCard
                key={ticket.id}
                ticket={ticket}
                detail={detailByNumber.get(ticket.number)}
                now={now}
              />
            ))}
          </>
        ) : isFiltered(filter) ? (
          <p className="quiet-line">Nothing{scope} needs you.</p>
        ) : (
          <h2 className="quiet-line">Nothing needs you.</h2>
        )}
      </section>
      <section className="moving" aria-labelledby="moving-heading">
        <h2 className="section-title" id="moving-heading">
          Moving
        </h2>
        {moving.length ? (
          <ul className="rows">
            {moving.map((ticket) => (
              <MovingRow
                key={ticket.id}
                ticket={ticket}
                factoryMerge={factoryMerges.has(ticket.number)}
                workflow={workflows.data?.workflows.find(
                  (item) => item.name === ticket.workflow.name,
                )}
                now={now}
              />
            ))}
          </ul>
        ) : (
          <p className="quiet-line">
            {scope ? `Nothing is moving${scope}.` : 'Nothing is moving.'}{' '}
            <a className="text-link" href="#/tickets/new">
              Start a ticket
            </a>
          </p>
        )}
      </section>
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
}: {
  ticket: Ticket
  detail: TicketResponse | undefined
  now: number
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
      style={repositoryTone(ticket.repository.id) as CSSProperties}
      aria-labelledby={`decision-${ticket.id}`}
    >
      <div className="decision-main">
        <p className="decision-meta">
          <RepositoryTag repository={ticket.repository} />
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

function MovingRow({
  ticket,
  factoryMerge,
  workflow,
  now,
}: {
  ticket: Ticket
  factoryMerge: boolean
  workflow: WorkflowSummary | undefined
  now: number
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
            <RepositoryTag repository={ticket.repository} />
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
