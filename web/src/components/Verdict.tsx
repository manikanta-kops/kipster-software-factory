import type { Repository, TicketResponse } from '../../../src/api/contract.ts'
import { ArtifactView } from './ArtifactView.tsx'
import { MarkdownBody } from './Shared.tsx'

function observed(commit: string | null): commit is string {
  return commit !== null && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit)
}

export function Commit({
  commit,
  repository,
}: {
  commit: string
  repository: Repository | undefined
}) {
  // The slug alone does not imply GitHub: repositories may use another host.
  const github = repository?.cloneUrl.match(
    /^(?:https?:\/\/github\.com\/|ssh:\/\/(?:git@)?github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i,
  )
  const short = <code>{commit.slice(0, 7)}</code>
  return github && observed(commit) ? (
    <a
      className="text-link"
      href={`https://github.com/${github[1]}/commit/${commit}`}
      target="_blank"
      rel="noreferrer"
      title={commit}
    >
      {short}
    </a>
  ) : (
    <span title={commit}>{short}</span>
  )
}

export function Verdict({
  detail,
  repository,
}: {
  detail: TicketResponse
  repository: Repository | undefined
}) {
  const index = detail.attempts.findLastIndex(
    (attempt) =>
      attempt.status === 'finished' &&
      attempt.waitingFor === null &&
      attempt.executor !== 'human' &&
      (attempt.outcome === 'passed' || attempt.outcome === 'changes-needed') &&
      detail.workflow.steps.some(
        (step) =>
          step.id === attempt.stepId &&
          step.kind === 'agent' &&
          step.does === 'tester',
      ),
  )
  const verdict = detail.attempts[index]
  if (!verdict) return null
  const known = observed(verdict.headCommit)
  const stale =
    known &&
    detail.attempts
      .slice(index + 1)
      .some(
        (attempt) =>
          observed(attempt.headCommit) &&
          attempt.headCommit !== verdict.headCommit,
      )
  const state = stale
    ? 'stale'
    : verdict.outcome === 'changes-needed'
      ? 'changes-needed'
      : known
        ? 'passed'
        : 'unknown'
  const findings = detail.artifacts.filter(
    (artifact) =>
      artifact.attemptId === verdict.id && artifact.kind === 'finding',
  )
  return (
    <section className={`verdict ${state}`} aria-label="Latest tester verdict">
      <h2>
        {stale ? (
          'Stale: new commits since verification'
        ) : verdict.outcome === 'changes-needed' ? (
          'Changes needed'
        ) : known ? (
          <>
            Verified at{' '}
            <Commit commit={verdict.headCommit!} repository={repository} />
          </>
        ) : (
          'Verification commit unknown'
        )}
      </h2>
      {(stale || verdict.outcome === 'changes-needed') && known && (
        <p className="muted">
          Tested at{' '}
          <Commit commit={verdict.headCommit!} repository={repository} />
        </p>
      )}
      {!known && (
        <p className="muted">
          No commit was recorded for this test run. Current changes are not
          verified.
        </p>
      )}
      {verdict.outcome === 'changes-needed' && (
        <>
          {verdict.summary && <MarkdownBody>{verdict.summary}</MarkdownBody>}
          {findings.map((artifact) => (
            <ArtifactView key={artifact.id} artifact={artifact} defaultOpen />
          ))}
        </>
      )}
    </section>
  )
}
