import { readFile } from 'node:fs/promises'
import { parseWorkflow } from '../../src/domain/workflow.ts'
import { workflowVersion } from '../../src/library/library.ts'
import type {
  DecisionFacts,
  DecisionInput,
} from '../../src/domain/decisions.ts'
export async function decisionWorkflow(withProof = false) {
  let source = await readFile(
    new URL('../fixtures/decision.yml', import.meta.url),
    'utf8',
  )
  if (withProof)
    source = source.replace(
      'steps:\n',
      'steps:\n  - id: proof-review\n    kind: agent\n    role: reviewer\n    routes:\n      passed: classify\n',
    )
  const parsed = parseWorkflow(source)
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'))
  return { source, version: workflowVersion(source), workflow: parsed.workflow }
}
export const facts: DecisionFacts = {
  ticket: { title: 'Fix checkout', body: 'Correct cart totals.' },
  base: { ref: 'origin/main', commit: 'a'.repeat(40) },
  headCommit: 'b'.repeat(40),
  files: [{ path: 'cart.ts', added: 3, removed: 1 }],
  verdicts: [],
  ci: null,
}
export const confirmDecision: DecisionInput = {
  question: 'Does this change need further owner review?',
  options: {
    proceed: 'Small change with proof.',
    review: 'Further owner review needed.',
  },
  bands: { act: 0.9, confirm: 0.6 },
  facts,
  answer: {
    model: 'jev-1.13.0',
    choice: 'proceed',
    probabilities: { proceed: 0.9, review: 0.1 },
    confidence: 0.8,
    usage: { inputTokens: 123, outputTokens: 20 },
  },
  band: 'confirm',
  reason: null,
  durationMs: 42,
}
