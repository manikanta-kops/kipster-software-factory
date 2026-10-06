import { MergeGatePanel } from '../components/MergeGate.tsx'
import { EvidenceIndex } from '../components/EvidenceIndex.tsx'
import { DecisionReview, DecisionDetails } from '../components/Decision.tsx'
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  Artifact,
  Attempt,
  FactoryEvent,
  HumanChoice,
  ResolveRequest,
  TicketResponse,
} from '../../../src/api/contract.ts'
import { describeAgent } from '../../../src/domain/settings.ts'
import { api } from '../api.ts'
import {
  attention,
  ErrorMessage,
  MarkdownBody,
  PullRequest,
  Status,
} from '../components/Shared.tsx'
import { repositoriesQuery, ticketQuery } from '../queries.ts'
import { ArtifactView } from '../components/ArtifactView.tsx'
import { RepositoryTag } from '../components/Filters.tsx'
import { Icon } from '../components/Icon.tsx'
import { agentLabel, doing, humanize, stepName } from '../words.ts'
import { Commit, Verdict } from '../components/Verdict.tsx'

export function TicketPage({
  number,
  evidenceId,
}: {
  number: number
  evidenceId?: number
}) {
  const query = useQuery(ticketQuery(number))
  const repositories = useQuery(repositoriesQuery)
  if (query.isPending) return <p className="muted">Loading ticket…</p>
  if (query.isError) return <ErrorMessage error={query.error} />
  const { ticket, workflow } = query.data
  const linkedWait = query.data.links?.find(
    (link) =>
      link.original.id === ticket.id &&
      link.attemptId === ticket.waiting?.attemptId &&
      ticket.waiting.for === 'other-repo',
  )
  const current = workflow.steps.find((step) => step.id === ticket.currentStep)
  const images = query.data.artifacts.filter(
    (artifact) =>
      artifact.content === null &&
      artifact.mediaType.startsWith('image/') &&
      !query.data.evidenceIndex?.some(
        (item) => item.artifactId === artifact.id,
      ),
  )
  return (
    <article className="ticket-page">
      <a className="back-link" href="#/" aria-label="Back to today">
        <Icon name="chevronLeft" size={13} stroke={2} />
        Today
      </a>
      <header className="ticket-heading">
        <p className="ticket-kicker">
          <RepositoryTag repository={ticket.repository} />
          <a href={`#/workflows/${ticket.workflow.name}`}>
            {humanize(workflow.name)}
          </a>
          <span>#{ticket.number}</span>
        </p>
        <h1>{ticket.title}</h1>
        <div className="ticket-meta">
          {linkedWait ? (
            <span className="ticket-doing">
              Waiting for linked ticket{' '}
              <a
                className="text-link"
                href={`#/tickets/${linkedWait.linked.number}`}
              >
                #{linkedWait.linked.number}
              </a>{' '}
              <Status value={linkedWait.linked.status} />
            </span>
          ) : (
            <Status value={ticket.status} />
          )}
          {!linkedWait && ['queued', 'running'].includes(ticket.status) && (
            <span className="ticket-doing">{doing(ticket, current)}</span>
          )}
          <PullRequest url={ticket.pullRequestUrl} />
        </div>
        {ticket.body && (
          <div className="ticket-body">
            <MarkdownBody>{ticket.body}</MarkdownBody>
          </div>
        )}
      </header>
      {ticket.waiting &&
        !['pull-request-checks', 'other-repo', 'tasks'].includes(
          ticket.waiting.for,
        ) && <ActionPanel key={ticket.waiting.attemptId} detail={query.data} />}
      <RepositoryContext detail={query.data} />
      <Tasks detail={query.data} />
      <MergeGatePanel detail={query.data} />
      <Verdict
        detail={query.data}
        repository={repositories.data?.repositories.find(
          (item) => item.id === ticket.repository.id,
        )}
      />
      <EvidenceIndex
        detail={query.data}
        {...(evidenceId === undefined ? {} : { selected: evidenceId })}
      />
      <StepList detail={query.data} />
      {images.length > 0 && (
        <section className="attachments" aria-labelledby="attachments-heading">
          <h2 className="section-title" id="attachments-heading">
            Attachments
          </h2>
          <div className="attachment-grid">
            {images.map((artifact) => (
              <ArtifactView key={artifact.id} artifact={artifact} />
            ))}
          </div>
        </section>
      )}
      <Timeline key={ticket.id} detail={query.data} />
    </article>
  )
}

function RepositoryContext({ detail }: { detail: TicketResponse }) {
  const { ticket, dependencies = [], links = [] } = detail
  if (!dependencies.length && !links.length) return null
  return (
    <section className="steps-card" aria-label="Repository context">
      {dependencies.length > 0 && (
        <>
          <h2 className="section-title">Read-only dependencies</h2>
          <ul>
            {dependencies.map((repository) => (
              <li key={repository.id}>
                {repository.slug}{' '}
                <span className="muted">
                  ({repository.defaultBranch}, refreshed before each agent
                  session)
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {links.length > 0 && (
        <>
          <h2 className="section-title">Linked tickets</h2>
          <ul>
            {links.map((link) => {
              const original = link.original.id === ticket.id
              const other = original ? link.linked : link.original
              return (
                <li key={link.id}>
                  {original ? 'Needs change in' : 'Requested by'}{' '}
                  {other.repository.slug}:{' '}
                  <a className="text-link" href={`#/tickets/${other.number}`}>
                    #{other.number} {other.title}
                  </a>{' '}
                  <Status value={other.status} />
                  <PullRequest url={other.pullRequestUrl} />
                  {link.mergeCommit && (
                    <span>
                      {' '}
                      Merge commit{' '}
                      <Commit
                        commit={link.mergeCommit}
                        repository={undefined}
                      />
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
          {ticket.waiting?.for === 'other-repo' && (
            <p>
              Waiting for the linked ticket’s pull request to merge. The builder
              will run again automatically.
            </p>
          )}
          {links.some((link) => link.original.id === ticket.id) && (
            <p className="muted">
              Cancelling this ticket does not cancel its linked tickets.
            </p>
          )}
          {ticket.waiting?.for === 'other-repo' && (
            <CancelLinkedWait number={ticket.number} />
          )}
        </>
      )}
    </section>
  )
}

function Tasks({ detail }: { detail: TicketResponse }) {
  const { tasks = [], parentTask } = detail
  if (!tasks.length && !parentTask) return null
  return (
    <section className="steps-card" aria-label="Tasks">
      {parentTask && (
        <>
          <h2 className="section-title">Lead ticket</h2>
          <p>
            Task <span className="task-key">{parentTask.key}</span> of{' '}
            <a
              className="text-link"
              href={`#/tickets/${parentTask.parent.number}`}
            >
              #{parentTask.parent.number} {parentTask.parent.title}
            </a>{' '}
            <Status value={parentTask.parent.status} />
          </p>
          <p className="muted">
            {parentTask.land === 'branch'
              ? 'When this ticket finishes, the system merges it into the lead’s branch.'
              : 'This task opens its own pull request. The lead decides whether the system merges it.'}
          </p>
        </>
      )}
      {tasks.length > 0 && (
        <>
          <h2 className="section-title">Tasks</h2>
          <ul className="task-list">
            {tasks.map((task) => (
              <li key={task.id}>
                <div className="task-line">
                  <span className="task-key">{task.key}</span>
                  <span>{task.title}</span>
                  <span className={`badge ${task.status}`}>
                    {task.status === 'pr-ready'
                      ? 'PR ready'
                      : task.status.replace('-', ' ')}
                  </span>
                  {task.child && (
                    <a
                      className="text-link"
                      href={`#/tickets/${task.child.number}`}
                    >
                      #{task.child.number}
                    </a>
                  )}
                  <PullRequest url={task.child?.pullRequestUrl ?? null} />
                </div>
                <p className="muted">
                  {task.land === 'pr' ? 'Own pull request' : 'Lead branch'}
                  {task.agent ? ` · ${agentLabel(task.agent)}` : ''}
                  {task.decision ? ` · lead chose ${task.decision}` : ''}
                </p>
                {task.result && <p>{task.result}</p>}
              </li>
            ))}
          </ul>
          <p className="muted">
            Cancelling this ticket cancels its unfinished tasks.
          </p>
        </>
      )}
    </section>
  )
}

function CancelLinkedWait({ number }: { number: number }) {
  const client = useQueryClient()
  const cancel = useMutation({
    mutationFn: () => api.cancel(number, {}),
    onSuccess: (data) => {
      client.setQueryData(['ticket', number], data)
      void client.invalidateQueries({ queryKey: ['tickets'] })
    },
  })
  return (
    <>
      <button
        className="danger"
        disabled={cancel.isPending}
        onClick={() => cancel.mutate()}
      >
        Cancel ticket
      </button>
      <ErrorMessage error={cancel.error} />
    </>
  )
}

type StepState =
  'done' | 'now' | 'you' | 'queued' | 'again' | 'next' | 'skipped' | 'stopped'

/** The workflow as a checklist: done, now, next. Loops show as run counts, never lines. */
function StepList({ detail }: { detail: TicketResponse }) {
  const { ticket, workflow, attempts } = detail
  const at = workflow.steps.findIndex((step) => step.id === ticket.currentStep)
  const active = ['queued', 'running', 'needs-you'].includes(ticket.status)
  const state = (index: number, runs: number): StepState => {
    if (index === at && active)
      return ticket.status === 'needs-you'
        ? 'you'
        : ticket.status === 'queued'
          ? 'queued'
          : 'now'
    if (index === at && ticket.status === 'cancelled') return 'stopped'
    if (runs > 0) return active && index > at ? 'again' : 'done'
    return ticket.status === 'done' ? 'skipped' : 'next'
  }
  const note = (stepId: string, value: StepState) => {
    if (value === 'you') return 'Your turn'
    if (value === 'queued') return 'Queued'
    if (value === 'now') return 'Now'
    if (value === 'stopped') return 'Stopped here'
    if (value === 'again') return 'Runs again'
    if (value !== 'done') return ''
    const last = attempts.findLast(
      (attempt) => attempt.stepId === stepId && attempt.finishedAt,
    )
    return last ? (last.outcome ?? '').replaceAll('-', ' ') : ''
  }
  return (
    <section className="steps-card" aria-labelledby="steps-heading">
      <h2 className="section-title" id="steps-heading">
        Steps
      </h2>
      <ol className="step-list">
        {workflow.steps.map((step, index) => {
          const value = state(index, step.runs)
          return (
            <li
              key={step.id}
              className={`step-item ${value}`}
              aria-current={index === at && active ? 'step' : undefined}
            >
              <span className="step-mark" aria-hidden="true">
                {value === 'done' || value === 'again' ? (
                  <Icon name="check" size={11} stroke={2.6} />
                ) : value === 'stopped' ? (
                  <Icon name="x" size={11} stroke={2.6} />
                ) : null}
              </span>
              <span className="step-name">
                {stepName(step)}
                {step.runs > 1 && (
                  <small className="step-runs">{step.runs} runs</small>
                )}
              </span>
              <span className="step-note">{note(step.id, value)}</span>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function Timeline({ detail }: { detail: TicketResponse }) {
  const [showAll, setShowAll] = useState(false)
  const entries = [
    ...detail.attempts
      .filter(
        (attempt) =>
          showAll ||
          attempt.finishedAt ||
          (attempt.startedAt &&
            attempt.waitingFor !== 'human' &&
            attempt.waitingFor !== 'ask'),
      )
      .map((attempt) => ({
        type: 'attempt' as const,
        item: attempt,
        time: attempt.finishedAt ?? attempt.startedAt ?? attempt.createdAt,
      })),
    ...detail.events
      .filter(
        (event) =>
          showAll ||
          event.kind === 'pull-request.merge-requested' ||
          event.kind === 'pull-request.merged' ||
          event.kind === 'post-merge.checked',
      )
      .map((event) => ({
        type: 'event' as const,
        item: event,
        time: event.createdAt,
      })),
  ].sort((a, b) => b.time.localeCompare(a.time) || b.item.id - a.item.id)
  return (
    <section aria-labelledby="timeline-heading">
      <div className="timeline-heading">
        <div>
          <h2 id="timeline-heading">What happened</h2>
          <p className="muted timeline-hint">Newest first</p>
        </div>
        <button
          className="timeline-toggle"
          aria-pressed={showAll}
          aria-controls="ticket-timeline"
          onClick={() => setShowAll(!showAll)}
        >
          Show all events
        </button>
      </div>
      {entries.length === 0 && (
        <p className="muted">No step runs or decisions yet.</p>
      )}
      <ol id="ticket-timeline" className="timeline">
        {entries.map((entry) =>
          entry.type === 'attempt' ? (
            <AttemptEntry
              key={`attempt-${entry.item.id}`}
              attempt={entry.item}
              detail={detail}
              artifacts={detail.artifacts.filter(
                (artifact) =>
                  artifact.attemptId === entry.item.id &&
                  !detail.evidenceIndex?.some(
                    (s) => s.artifactId === artifact.id,
                  ),
              )}
            />
          ) : (
            <EventEntry key={`event-${entry.item.id}`} event={entry.item} />
          ),
        )}
      </ol>
    </section>
  )
}

function ActionPanel({ detail }: { detail: TicketResponse }) {
  const typed = detail.decisions?.find(
    (item) => item.attemptId === detail.ticket.waiting?.attemptId,
  )
  if (detail.ticket.waiting?.for === 'decision' && typed)
    return <DecisionReview decision={typed} />
  return <StandardActionPanel detail={detail} />
}

function StandardActionPanel({ detail }: { detail: TicketResponse }) {
  const repositories = useQuery(repositoriesQuery)
  const autoMerge = repositories.data?.repositories.find(
    (repository) => repository.id === detail.ticket.repository.id,
  )?.autoMerge
  const factoryMerge =
    autoMerge && detail.mergeGate && !detail.mergeGate.latest.needsOwner.length
  const { ticket, workflow, artifacts } = detail
  const waiting = ticket.waiting!
  const client = useQueryClient()
  const [comment, setComment] = useState('')
  const [note, setNote] = useState('')
  const [stepId, setStepId] = useState('')
  const [validation, setValidation] = useState('')
  const mutation = useMutation({
    mutationFn: (action: { choice: HumanChoice } | ResolveRequest) =>
      'choice' in action
        ? api.decide(ticket.number, {
            attemptId: waiting.attemptId,
            choice: action.choice,
            comment: comment.trim(),
          })
        : api.resolve(ticket.number, action),
    onSuccess: (data) => {
      client.setQueryData(['ticket', ticket.number], data)
      void client.invalidateQueries({ queryKey: ['tickets'] })
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: ['ticket', ticket.number] })
    },
  })
  const decide = (choice: HumanChoice) => {
    if (choice === 'changes-needed' && !comment.trim()) {
      setValidation('Add a comment to explain the changes needed.')
      return
    }
    setValidation('')
    mutation.mutate({ choice })
  }
  const resolve = (action: 'retry' | 'move' | 'cancel') => {
    if (action !== 'cancel' && !note.trim()) {
      setValidation('Add a note for the next attempt.')
      return
    }
    if (action === 'move' && !stepId) {
      setValidation('Choose a step to move to.')
      return
    }
    setValidation('')
    mutation.mutate(
      action === 'move'
        ? { attemptId: waiting.attemptId, action, stepId, note: note.trim() }
        : { attemptId: waiting.attemptId, action, note: note.trim() },
    )
  }
  const plan = artifacts.filter((artifact) => artifact.kind === 'plan').at(-1)
  return (
    <section className="action-panel" aria-labelledby="action-heading">
      <h2 id="action-heading">
        {factoryMerge && waiting.for === 'pull-request-merge'
          ? 'Factory merge pending'
          : attention(ticket)}
      </h2>
      {waiting.summary && <p>{waiting.summary}</p>}
      {waiting.for === 'pull-request-merge' ? (
        <p>
          {factoryMerge
            ? 'The factory will merge after re-checking the current proof, review and checks.'
            : 'Review the pull request and merge it when you’re ready.'}{' '}
          <PullRequest url={ticket.pullRequestUrl} />
        </p>
      ) : (
        <>
          {waiting.for === 'human' && plan && (
            <ArtifactView key={plan.id} artifact={plan} defaultOpen />
          )}
          <fieldset disabled={mutation.isPending} className="action-fields">
            {waiting.for === 'human' ? (
              <>
                <label htmlFor="decision-comment">
                  Comment <span className="muted">Required for changes</span>
                </label>
                <textarea
                  id="decision-comment"
                  rows={3}
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                />
                <div className="actions">
                  <button
                    className="primary"
                    onClick={() => decide('approved')}
                  >
                    Approve
                  </button>
                  <button onClick={() => decide('changes-needed')}>
                    Request changes
                  </button>
                  <button className="danger" onClick={() => decide('rejected')}>
                    Reject
                  </button>
                </div>
              </>
            ) : (
              <>
                <label htmlFor="ask-note">
                  Note <span className="muted">Required to retry or move</span>
                </label>
                <textarea
                  id="ask-note"
                  rows={3}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
                <div className="actions">
                  <button className="primary" onClick={() => resolve('retry')}>
                    Retry step
                  </button>
                </div>
                <label htmlFor="move-step">Move to step</label>
                <div className="input-row">
                  <select
                    id="move-step"
                    value={stepId}
                    onChange={(event) => setStepId(event.target.value)}
                  >
                    <option value="">Choose a step</option>
                    {workflow.steps.map((step) => (
                      <option key={step.id} value={step.id}>
                        {step.id}
                      </option>
                    ))}
                  </select>
                  <button onClick={() => resolve('move')}>Move ticket</button>
                </div>
                <button
                  className="danger cancel-ticket"
                  onClick={() => resolve('cancel')}
                >
                  Cancel ticket
                </button>
              </>
            )}
          </fieldset>
          {validation && (
            <p className="error" role="alert">
              {validation}
            </p>
          )}
          <ErrorMessage error={mutation.error} />
          {mutation.isPending && <output>Saving decision…</output>}
        </>
      )}
    </section>
  )
}

function duration(attempt: Attempt, now: number) {
  const start = attempt.startedAt ?? attempt.waitingSince
  if (!start) return 'Not started'
  const seconds = Math.max(
    0,
    Math.round(
      ((attempt.finishedAt ? Date.parse(attempt.finishedAt) : now) -
        Date.parse(start)) /
        1000,
    ),
  )
  const value =
    seconds < 60
      ? `${seconds}s`
      : seconds < 3600
        ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
        : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
  return attempt.finishedAt ? value : `${value} elapsed`
}
function AttemptDuration({ attempt }: { attempt: Attempt }) {
  const [now, setNow] = useState(Date.now)
  const active =
    !attempt.finishedAt && Boolean(attempt.startedAt ?? attempt.waitingSince)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return <span>{duration(attempt, now)}</span>
}
function Time({ value }: { value: string }) {
  return (
    <time dateTime={value} title={new Date(value).toLocaleString()}>
      {new Date(value).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })}
    </time>
  )
}
function AttemptEntry({
  attempt,
  detail,
  artifacts,
}: {
  attempt: Attempt
  detail: TicketResponse
  artifacts: readonly Artifact[]
}) {
  const repositories = useQuery(repositoriesQuery)
  const repository = repositories.data?.repositories.find(
    (item) => item.id === detail.ticket.repository.id,
  )
  const step = detail.workflow.steps.find((item) => item.id === attempt.stepId)
  const resolution = detail.events.find(
    (event) =>
      event.kind === 'ask.resolved' && event.data['attemptId'] === attempt.id,
  )
  const outcome = resolution
    ? resolution.data['action'] === 'move'
      ? `Moved to ${String(resolution.data['stepId'])}`
      : resolution.data['action'] === 'retry'
        ? 'Retry requested'
        : 'Cancelled'
    : (attempt.outcome ?? attempt.status)
  return (
    <li className="attempt-entry">
      <div className="entry-heading">
        <h3>
          {attempt.stepId}{' '}
          <span className="muted">
            {attempt.executor === 'human'
              ? 'human decision'
              : attempt.waitingFor === 'ask'
                ? 'ask'
                : (step?.does ?? 'you decide')}
          </span>
        </h3>
        <Time
          value={attempt.finishedAt ?? attempt.startedAt ?? attempt.createdAt}
        />
      </div>
      <div className="attempt-meta">
        <Status value={outcome} />
        <span>
          {attempt.agent
            ? describeAgent(attempt.agent)
            : (attempt.executor ?? 'Unassigned')}
        </span>
        <AttemptDuration attempt={attempt} />
        {attempt.headCommit && (
          <span>
            Commit{' '}
            <Commit commit={attempt.headCommit} repository={repository} />
          </span>
        )}
      </div>
      {detail.decisions
        ?.filter((item) => item.attemptId === attempt.id)
        .map((item) => (
          <DecisionDetails key={item.id} decision={item} />
        ))}
      {attempt.summary && <MarkdownBody>{attempt.summary}</MarkdownBody>}
      {attempt.error && <p className="error">{attempt.error}</p>}
      {artifacts.map((artifact) => (
        <ArtifactView
          key={artifact.id}
          artifact={artifact}
          ticketNumber={detail.ticket.number}
          defaultOpen={attempt.executor === 'human' && artifact.kind === 'note'}
          live={attempt.status === 'running' && artifact.kind === 'log'}
        />
      ))}
    </li>
  )
}
function EventEntry({ event }: { event: FactoryEvent }) {
  const summary =
    typeof event.data['summary'] === 'string'
      ? event.data['summary']
      : undefined
  const step =
    typeof event.data['stepId'] === 'string' ? event.data['stepId'] : undefined
  return (
    <li className="event-entry">
      <div className="entry-heading">
        <span>
          {event.kind.replaceAll('.', ' · ').replaceAll('-', ' ')}
          {step ? ` · ${step}` : ''}
        </span>
        <Time value={event.createdAt} />
      </div>
      {summary && (
        <p>
          {event.kind === 'post-merge.checked' &&
          typeof event.data['bugTicketNumber'] === 'number' ? (
            <>
              Post-merge breakage:{' '}
              <a
                className="text-link"
                href={`#/tickets/${event.data['bugTicketNumber']}`}
              >
                bug ticket #{event.data['bugTicketNumber']}
              </a>{' '}
              opened for {String(event.data['mergeCommit'])}.
            </>
          ) : (
            summary
          )}
        </p>
      )}
      <details>
        <summary>Event details</summary>
        <pre>{JSON.stringify(event.data, null, 2)}</pre>
      </details>
    </li>
  )
}
