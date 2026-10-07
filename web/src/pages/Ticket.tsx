import { TicketSummaryCard } from '../components/TicketSummary.tsx'
import { MergeGatePanel } from '../components/MergeGate.tsx'
import { EvidenceIndex } from '../components/EvidenceIndex.tsx'
import { DecisionReview, DecisionDetails } from '../components/Decision.tsx'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  Artifact,
  Attempt,
  FactoryEvent,
  HumanChoice,
  LeadTask,
  ResolveRequest,
  TaskStatus,
  TicketResponse,
} from '../../../src/api/contract.ts'
import { untestedReasons } from '../../../src/domain/task-testing.ts'
import { describeAgent } from '../../../src/domain/settings.ts'
import { isFinalTask } from '../../../src/domain/tasks.ts'
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
import { isMedia, MediaGallery, MediaLibrary } from '../components/Media.tsx'
import { RepositoryTag } from '../components/Filters.tsx'
import { Icon, stepHue, stepIcon } from '../components/Icon.tsx'
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
  const media = query.data.artifacts.filter(
    (artifact) =>
      isMedia(artifact) &&
      !query.data.evidenceIndex?.some(
        (item) => item.artifactId === artifact.id,
      ),
  )
  const awaitingAction =
    ticket.waiting &&
    !['pull-request-checks', 'other-repo', 'tasks'].includes(ticket.waiting.for)
  return (
    <article className="ticket-page">
      <header className="ticket-heading">
        <a className="back-link" href="#/" aria-label="Back to today">
          <Icon name="chevronLeft" size={13} stroke={2} />
          Today
        </a>
        <p className="ticket-kicker">
          <RepositoryTag repository={ticket.repository} />
          <a href={`#/workflows/${ticket.workflow.name}`}>
            {humanize(workflow.name)}
          </a>
          <span>#{ticket.number}</span>
        </p>
        <h1>{ticket.title}</h1>
        <div className="ticket-meta">
          {ticket.lightsOut && <span className="badge">Lights-out</span>}
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
          {untestedReasons(query.data).map((reason) => (
            <span className="badge" key={reason}>
              {reason}
            </span>
          ))}
        </div>
      </header>
      {ticket.summary &&
        ['done', 'cancelled', 'needs-you'].includes(ticket.status) && (
          <TicketSummaryCard summary={ticket.summary} />
        )}
      <div className="ticket-primary" id="ticket-details" tabIndex={-1}>
        {awaitingAction ? (
          <ActionPanel key={ticket.waiting!.attemptId} detail={query.data} />
        ) : (
          <NowCard detail={query.data} />
        )}
        {ticket.body && <Description body={ticket.body} />}
        <Tasks detail={query.data} />
        <AgentDecisions detail={query.data} />
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
        {media.length > 0 && (
          <MediaLibrary
            artifacts={media}
            attempts={query.data.attempts}
            ticketNumber={ticket.number}
          />
        )}
      </div>
      <aside className="ticket-side">
        <StepList detail={query.data} />
        <Details detail={query.data} />
        <RepositoryContext detail={query.data} />
      </aside>
      <div className="ticket-history">
        <Timeline key={ticket.id} detail={query.data} />
      </div>
    </article>
  )
}

/** What the factory is doing right now, so the page answers that before anything else. */
function NowCard({ detail }: { detail: TicketResponse }) {
  const { ticket, workflow, attempts } = detail
  if (!['queued', 'running'].includes(ticket.status)) return null
  const at = workflow.steps.findIndex((step) => step.id === ticket.currentStep)
  const step = workflow.steps[at]
  const running = attempts.findLast(
    (attempt) => attempt.stepId === ticket.currentStep && !attempt.finishedAt,
  )
  const latest = attempts.findLast(
    (attempt) => attempt.finishedAt && attempt.summary,
  )
  const queued = ticket.status === 'queued'
  return (
    <section className={`now-card${queued ? ' queued' : ''}`} aria-label="Now">
      <span className={`now-icon hue-${stepHue(step)}`} aria-hidden="true">
        <Icon name={queued ? 'clock' : stepIcon(step)} size={18} />
      </span>
      <div className="now-main">
        <h2>{doing(ticket, step)}</h2>
        <p className="now-meta">
          {at >= 0 && (
            <span>
              Step {at + 1} of {workflow.steps.length}
              {step ? ` · ${stepName(step)}` : ''}
            </span>
          )}
          {running?.executor && <span>{running.executor}</span>}
          {running?.startedAt && <AttemptDuration attempt={running} />}
        </p>
        {latest && (
          <div className="now-latest">
            <span className="now-latest-label">
              Latest from {humanize(latest.stepId)}
            </span>
            <ClampedText lines={3}>{latest.summary!}</ClampedText>
          </div>
        )}
      </div>
    </section>
  )
}

function Description({ body }: { body: string }) {
  const [open, setOpen] = useState(false)
  const [long, setLong] = useState(false)
  const content = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const inner = content.current?.firstElementChild
    if (!inner) return
    const measure = () => setLong(inner.scrollHeight > 300)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(inner)
    return () => observer.disconnect()
  }, [])
  return (
    <section className="description-card" aria-label="Description">
      <h2 className="section-title">Description</h2>
      <div
        ref={content}
        className={`description-body${long && !open ? ' folded' : ''}`}
      >
        <MarkdownBody>{body}</MarkdownBody>
      </div>
      {long && (
        <button
          type="button"
          className="quiet more-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Show less' : 'Show full description'}
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        </button>
      )}
    </section>
  )
}

/** Text clamped to a few lines, with a toggle only when it overflows. */
function ClampedText({ children, lines }: { children: string; lines: number }) {
  const [open, setOpen] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const content = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = content.current
    const inner = element?.firstElementChild
    if (!element || !inner || open) return
    const measure = () =>
      setOverflows(element.scrollHeight > element.clientHeight + 2)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(inner)
    return () => observer.disconnect()
  }, [open])
  return (
    <div className="clamped">
      <div
        ref={content}
        className={open ? undefined : overflows ? 'clamp faded' : 'clamp'}
        style={{ '--lines': lines } as CSSProperties}
      >
        <MarkdownBody>{children}</MarkdownBody>
      </div>
      {(overflows || open) && (
        <button
          type="button"
          className="quiet more-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

function Details({ detail }: { detail: TicketResponse }) {
  const { ticket } = detail
  const pullRequest =
    ticket.pullRequestUrl && /^https?:\/\//i.test(ticket.pullRequestUrl)
      ? ticket.pullRequestUrl
      : null
  return (
    <section className="side-card" aria-label="Details">
      <h2 className="section-title">Details</h2>
      <dl className="details-list">
        <div>
          <dt>Pull request</dt>
          <dd>
            {pullRequest ? (
              <a
                className="text-link"
                href={pullRequest}
                target="_blank"
                rel="noreferrer"
              >
                #{/\/pull\/(\d+)/.exec(pullRequest)?.[1] ?? 'Open'} ↗
              </a>
            ) : (
              <span className="muted">Not opened yet</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Repository</dt>
          <dd>
            <RepositoryTag repository={ticket.repository} />
          </dd>
        </div>
        <div>
          <dt>Workflow</dt>
          <dd>
            <a href={`#/workflows/${ticket.workflow.name}`}>
              {humanize(ticket.workflow.name)}
            </a>
          </dd>
        </div>
        {ticket.branch && (
          <div>
            <dt>Branch</dt>
            <dd>
              <code className="branch" title={ticket.branch}>
                {ticket.branch}
              </code>
            </dd>
          </div>
        )}
        <div>
          <dt>Started</dt>
          <dd>
            <Time value={ticket.createdAt} />
          </dd>
        </div>
      </dl>
    </section>
  )
}

function RepositoryContext({ detail }: { detail: TicketResponse }) {
  const { ticket, dependencies = [], links = [] } = detail
  if (!dependencies.length && !links.length) return null
  return (
    <section className="side-card" aria-label="Repository context">
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
  const active = tasks.filter((task) => !isFinalTask(task.status))
  const finished = tasks.filter((task) => isFinalTask(task.status))
  return (
    <section className="steps-card tasks-card" aria-label="Tasks">
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
          <h2 className="section-title">
            Tasks
            <span className="steps-progress">
              {finished.length} of {tasks.length} finished
            </span>
          </h2>
          <div className="task-progress" aria-hidden="true">
            {tasks.map((task) => (
              <i key={task.id} className={task.status} />
            ))}
          </div>
          {active.length > 0 ? (
            <ul className="task-list" aria-label="Tasks in progress">
              {active.map((task) => (
                <li key={task.id}>
                  <div className="task-row">
                    <div className="task-head">
                      <span className={`task-dot ${task.status}`} />
                      <TaskName task={task} />
                    </div>
                    <ChildLink task={task} />
                  </div>
                  <TaskFacts task={task} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="task-all-finished">
              <Icon name="check" size={13} stroke={2.4} />
              All tasks finished
            </p>
          )}
          {finished.length > 0 && <FinishedTasks tasks={finished} />}
          {active.length > 0 && (
            <p className="muted task-note">
              Cancelling this ticket cancels its unfinished tasks.
            </p>
          )}
        </>
      )}
    </section>
  )
}

const FINISHED_ORDER: readonly TaskStatus[] = [
  'merged',
  'left-open',
  'conflict',
  'failed',
  'cancelled',
]

function FinishedTasks({ tasks }: { tasks: readonly LeadTask[] }) {
  const [open, setOpen] = useState(false)
  const tallies = FINISHED_ORDER.map((status) => ({
    status,
    count: tasks.filter((task) => task.status === status).length,
  })).filter((tally) => tally.count > 0)
  return (
    <div className="finished-tasks">
      <button
        type="button"
        className="finished-tasks-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="chevronRight" size={12} stroke={2.2} />
        <span className="finished-tasks-label">Finished</span>
        <span className="finished-tasks-count">{tasks.length}</span>
        <span className="finished-tasks-tallies">
          {tallies.map((tally) => (
            <span key={tally.status} className={`tally ${tally.status}`}>
              {tally.count} {taskStatusLabel(tally.status).toLowerCase()}
            </span>
          ))}
        </span>
      </button>
      {open && (
        <ul className="task-list finished" aria-label="Finished tasks">
          {tasks.map((task) => (
            <FinishedTask key={task.id} task={task} />
          ))}
        </ul>
      )}
    </div>
  )
}

function FinishedTask({ task }: { task: LeadTask }) {
  const [open, setOpen] = useState(false)
  return (
    <li className={open ? 'open' : undefined}>
      <div className="task-row">
        <button
          type="button"
          className="task-head"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Icon name="chevronRight" size={12} stroke={2.2} />
          <TaskName task={task} />
        </button>
        <ChildLink task={task} />
      </div>
      {open && <TaskFacts task={task} />}
    </li>
  )
}

function TaskName({ task }: { task: LeadTask }) {
  return (
    <>
      <span className="task-key">{task.key}</span>
      <span className="task-title">{task.title}</span>
      <span className={`badge ${task.status}`}>
        {taskStatusLabel(task.status)}
      </span>
    </>
  )
}

function ChildLink({ task }: { task: LeadTask }) {
  if (!task.child) return <span className="task-child" />
  return (
    <a className="task-child text-link" href={`#/tickets/${task.child.number}`}>
      #{task.child.number}
    </a>
  )
}

function TaskFacts({ task }: { task: LeadTask }) {
  return (
    <div className="task-facts">
      <p className="task-meta">
        {task.land === 'pr' ? 'Own pull request' : 'Lead branch'}
        {task.agent ? ` · ${agentLabel(task.agent)}` : ''}
        {task.decision ? ` · lead chose ${task.decision}` : ''}
      </p>
      {task.result && <p className="task-result">{task.result}</p>}
      <PullRequest url={task.child?.pullRequestUrl ?? null} />
    </div>
  )
}

function taskStatusLabel(status: TaskStatus) {
  if (status === 'pr-ready') return 'PR ready'
  const words = status.replace('-', ' ')
  return words[0]!.toUpperCase() + words.slice(1)
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
    <section className="side-card" aria-labelledby="steps-heading">
      <h2 className="section-title" id="steps-heading">
        Steps
        {at >= 0 && (
          <span className="steps-progress">
            {Math.min(
              at + (ticket.status === 'done' ? 1 : 0),
              workflow.steps.length,
            )}{' '}
            of {workflow.steps.length} done
          </span>
        )}
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
                <div className="ask-actions">
                  <button className="primary" onClick={() => resolve('retry')}>
                    Retry step
                  </button>
                  <span className="ask-or">or</span>
                  <label htmlFor="move-step" className="sr-only">
                    Move to step
                  </label>
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
                  <button
                    className="danger cancel-ticket"
                    onClick={() => resolve('cancel')}
                  >
                    Cancel ticket
                  </button>
                </div>
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
      {attempt.summary && (
        <ClampedText lines={4}>{attempt.summary}</ClampedText>
      )}
      {attempt.error && <p className="error">{attempt.error}</p>}
      {artifacts.some(isMedia) && (
        <MediaGallery
          artifacts={artifacts.filter(isMedia)}
          ticketNumber={detail.ticket.number}
          compact
          limit={6}
        />
      )}
      <FileList
        files={artifacts.filter((artifact) => !isMedia(artifact))}
        attempt={attempt}
        ticketNumber={detail.ticket.number}
      />
    </li>
  )
}
const FILES_SHOWN = 3

function FileList({
  files,
  attempt,
  ticketNumber,
}: {
  files: readonly Artifact[]
  attempt: Attempt
  ticketNumber: number
}) {
  const [all, setAll] = useState(false)
  if (!files.length) return null
  const shown = all ? files : files.slice(0, FILES_SHOWN)
  return (
    <div className="file-list">
      {shown.map((artifact) => (
        <ArtifactView
          key={artifact.id}
          artifact={artifact}
          ticketNumber={ticketNumber}
          defaultOpen={attempt.executor === 'human' && artifact.kind === 'note'}
          live={attempt.status === 'running' && artifact.kind === 'log'}
        />
      ))}
      {files.length > FILES_SHOWN && (
        <button
          type="button"
          className="quiet more-toggle"
          aria-expanded={all}
          onClick={() => setAll(!all)}
        >
          {all
            ? 'Show fewer files'
            : `Show ${files.length - FILES_SHOWN} more files`}
        </button>
      )}
    </div>
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

function AgentDecisions({ detail }: { detail: TicketResponse }) {
  const decisions = detail.artifacts.filter(
    (artifact) => artifact.kind === 'decision' && artifact.decision,
  )
  const children = (detail.tasks ?? []).filter((task) => task.child)
  if (!decisions.length && !children.length) return null
  return (
    <section className="steps-card" aria-label="Decision log">
      <h2 className="section-title">Decision log</h2>
      {decisions.map((artifact) => (
        <div key={artifact.id}>
          <h3>{artifact.title}</h3>
          <dl>
            <dt>Chose</dt>
            <dd>
              <MarkdownBody>{artifact.decision!.chose}</MarkdownBody>
            </dd>
            <dt>Alternative</dt>
            <dd>
              <MarkdownBody>{artifact.decision!.alternative}</MarkdownBody>
            </dd>
            <dt>Reason</dt>
            <dd>
              <MarkdownBody>{artifact.decision!.reason}</MarkdownBody>
            </dd>
          </dl>
        </div>
      ))}
      {children.length > 0 && (
        <ul>
          {children.map((task) => (
            <li key={task.id}>
              <a className="text-link" href={`#/tickets/${task.child!.number}`}>
                Decisions from {task.title} (#{task.child!.number})
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
