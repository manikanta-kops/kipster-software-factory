import type { TicketResponse } from '../../../src/api/contract.ts'
export function MergeGatePanel({ detail }: { detail: TicketResponse }) {
  const snapshot = detail.mergeGate
  if (!snapshot)
    return detail.ticket.pullRequestUrl ? (
      <section className="verdict unknown" aria-label="Merge gate">
        <h2>Blocked: merge gate has not been evaluated</h2>
      </section>
    ) : null
  const gate = snapshot.latest
  const { facts } = gate
  return (
    <section
      className={`verdict ${gate.ready ? 'passed' : 'changes-needed'}`}
      aria-label="Merge gate"
    >
      <h2>
        {gate.ready ? 'Ready to merge' : `Blocked: ${gate.blockers.join('; ')}`}
      </h2>
      {gate.paths.length > 0 && (
        <p>
          <strong>
            Needs you: touches {gate.paths.map((p) => p.path).join(', ')}
          </strong>
        </p>
      )}
      {gate.needsOwner
        .filter((s) => !s.startsWith('Touches '))
        .map((s) => (
          <p key={s}>Needs you: {s}</p>
        ))}
      {snapshot.lastGreen &&
        (snapshot.lastGreen.facts.head !== facts.localHead || !gate.ready) && (
          <p>
            Earlier green head:{' '}
            <code>{snapshot.lastGreen.facts.head.slice(0, 7)}</code>. Current
            work still needs the gate.
          </p>
        )}
      <p className="muted">
        PR head <code>{facts.head.slice(0, 7)}</code> · Checked{' '}
        {new Date(gate.evaluatedAt).toLocaleString()}
      </p>
      <details open={!['passed', 'none'].includes(facts.ci)}>
        <summary>
          Live CI at <code>{facts.head.slice(0, 7)}</code>:{' '}
          {facts.ci === 'none' ? 'No checks configured' : facts.ci}
        </summary>
        <ul aria-label="Current CI checks">
          {facts.checks.map((check, index) => (
            <li key={`${check.name}-${index}`}>
              {check.url ? (
                <a href={check.url} target="_blank" rel="noreferrer">
                  {check.name}
                </a>
              ) : (
                check.name
              )}
              : {check.state}
              {check.required ? ' · required' : ''}
            </li>
          ))}
        </ul>
        <p className="muted">
          The PR description records publication-time observations.
        </p>
      </details>
      <details>
        <summary>Proof and gate facts</summary>
        <p>
          Independent tester:{' '}
          {facts.hasTester
            ? `${facts.tester?.outcome ?? 'no verdict'} at ${facts.tester?.commit?.slice(0, 7) ?? 'unknown commit'}`
            : 'untested'}
        </p>
        {facts.hasReproducer && (
          <p>
            Independent reproduction comparison:{' '}
            {facts.reproducer?.outcome ?? 'no verdict'} at{' '}
            {facts.reproducer?.commit?.slice(0, 7) ?? 'unknown commit'}
          </p>
        )}
        <p>
          Repository checks:{' '}
          {facts.ci === 'none' ? 'No checks configured' : facts.ci}
        </p>
        <p>
          Owner-approved unverified scenarios:{' '}
          {facts.approvedUnverified === null
            ? 'data unavailable'
            : facts.approvedUnverified.join(', ') || 'none'}
        </p>
        <p>
          Base <code>{facts.base.slice(0, 7)}</code> · {facts.behind} missing
          commits
        </p>
      </details>
    </section>
  )
}
