import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { DecisionRecord } from '../../../src/api/contract.ts'
import { api } from '../api.ts'
import { ErrorMessage } from './Shared.tsx'

const percent = (value: number) => `${(value * 100).toFixed(1)}%`
export function DecisionDetails({ decision: d }: { decision: DecisionRecord }) {
  return (
    <div className="decision-details">
      <p>
        <strong>{d.question}</strong>
      </p>
      <p>
        {d.finalOption
          ? `Answer: ${d.finalOption} · decided by ${d.decidedBy}${d.overridden ? ' · owner override' : ''}`
          : d.pending
            ? 'Awaiting owner decision'
            : 'Closed without an option'}
      </p>
      <p className="muted">
        Band: {d.band} · Model: {d.answer?.model ?? 'not used'} · Confidence:{' '}
        {d.answer ? percent(d.answer.confidence) : 'unavailable'}
      </p>
      {d.answer && (
        <p className="muted">
          Model choice: {d.answer.choice} ·{' '}
          {Object.entries(d.answer.probabilities)
            .map(
              ([option, probability]) => `${option}: ${percent(probability)}`,
            )
            .join(' · ')}
        </p>
      )}
      {d.reason && <p>{d.reason}</p>}
      <details>
        <summary>Decision facts and thresholds</summary>
        <pre>
          {JSON.stringify(
            {
              facts: d.facts,
              bands: d.bands,
              usage: d.answer?.usage ?? null,
              durationMs: d.durationMs,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </div>
  )
}
export function DecisionReview({ decision: d }: { decision: DecisionRecord }) {
  const client = useQueryClient()
  const mutation = useMutation({
    mutationFn: (option: string) =>
      d.purpose === 'merge'
        ? api.mergeOption(d.ticketNumber, {
            decisionId: d.id,
            option: option === 'merge' ? 'merge' : 'owner',
          })
        : api.decideOption(d.ticketNumber, { attemptId: d.attemptId, option }),
    onSuccess: (data) => {
      client.setQueryData(['ticket', d.ticketNumber], data)
      void client.invalidateQueries({ queryKey: ['tickets'] })
      void client.invalidateQueries({ queryKey: ['decisions'] })
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: ['ticket', d.ticketNumber] })
    },
  })
  return (
    <section className="action-panel" aria-labelledby="typed-decision-heading">
      <h2 id="typed-decision-heading">
        {d.band === 'confirm' ? 'Confirm the proposed option' : 'You decide'}
      </h2>
      <DecisionDetails decision={d} />
      {d.band === 'owner' && (
        <p>
          The probabilities are information only. Choose the option you judge
          appropriate.
        </p>
      )}
      <fieldset disabled={mutation.isPending} className="action-fields">
        {d.band === 'confirm' && d.answer && (
          <button
            className="primary"
            onClick={() => mutation.mutate(d.answer!.choice)}
          >
            Accept {d.answer.choice}
          </button>
        )}
        <div className="decision-options">
          {Object.entries(d.options).map(([option, description]) => (
            <div key={option}>
              <button onClick={() => mutation.mutate(option)}>
                {d.purpose === 'merge'
                  ? option === 'merge'
                    ? 'Merge'
                    : 'I’ll review'
                  : `Choose ${option}`}
              </button>
              <p className="muted">{description}</p>
            </div>
          ))}
        </div>
      </fieldset>
      <ErrorMessage error={mutation.error} />
      {mutation.isPending && <output>Saving decision…</output>}
    </section>
  )
}
