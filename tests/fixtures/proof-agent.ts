import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface ProofContext {
  instances: {
    surface: string
    commit: string
    /** Null when no app was started for the checker. */
    url: string | null
    evidenceDir: string
    checkout: string
    databaseUrl: string | null
  }[]
  app?: {
    started: false
    reason: string
    suggestedCommands: { setup: string | null; check: string | null }
  }
}
export function proofContext(prompt: string): ProofContext {
  const marker =
    'Verification context (factory-owned instances; use these exact URLs and evidence directories):\n'
  return JSON.parse(prompt.split(marker)[1]!.split('\n\n')[0]!) as ProofContext
}
export async function driveProof({
  instruction,
  prompt,
  directory,
}: {
  instruction: {
    outcome?: string
    wait?: boolean
    edit?: boolean
    crash?: boolean
    noEvidence?: boolean
    proseOnly?: boolean
  }
  prompt: string
  directory: string
}) {
  const context = proofContext(prompt)
  const artifacts: {
    scenario?: string
    scenarioResult?: string
    kind: string
    title: string
    path?: string
    content?: string
  }[] = []
  const observations = []
  for (const instance of context.instances) {
    const response = await fetch(`${instance.url}/checkout`, {
      method: 'POST',
      body: '{}',
    })
    const body = await response.text()
    const path = join(instance.evidenceDir, `${instance.surface}-checkout.json`)
    const observation = {
      ...instance,
      status: response.status,
      body,
      agentCwd: process.cwd(),
      head: execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
    }
    observations.push(observation)
    if (!instruction.noEvidence) {
      await writeFile(path, JSON.stringify(observation, null, 2))
      artifacts.push(
        instruction.proseOnly
          ? { kind: 'evidence', title: 'Claim', content: 'I tested it' }
          : {
              kind: 'evidence',
              scenario: 'Place order',
              scenarioResult:
                response.status === (instance.surface === 'base' ? 500 : 200)
                  ? instance.surface === 'base'
                    ? 'reproduced'
                    : 'passed'
                  : 'failed',
              title: `${instance.surface} checkout response`,
              path,
            },
      )
    }
    if (instruction.crash)
      process.kill((JSON.parse(body) as { pid: number }).pid, 'SIGKILL')
  }
  await writeFile(
    join(directory, 'observations.json'),
    JSON.stringify(observations),
  )
  if (instruction.edit) {
    await writeFile('tester-only.txt', 'must be discarded')
    execFileSync('git', ['add', '.'])
    execFileSync('git', [
      '-c',
      'user.name=Tester',
      '-c',
      'user.email=test@example.test',
      'commit',
      '-m',
      'Disposable tester edit',
    ])
  }
  if (instruction.wait) await new Promise(() => setInterval(() => {}, 1000))
  const reproducer = prompt.startsWith('You are the reproducer')
  const passed = observations.every(
    (o) => o.status === (o.surface === 'base' ? 500 : 200),
  )
  const outcome =
    instruction.outcome ??
    (reproducer
      ? passed
        ? 'reproduced'
        : 'not-reproduced'
      : passed
        ? 'passed'
        : 'changes-needed')
  if (reproducer) {
    const path = join(
      context.instances[0]!.evidenceDir,
      'reproduction-steps.md',
    )
    await writeFile(
      path,
      `1. POST /checkout with an empty JSON body on a fresh fixture.\n2. Expect HTTP 200 and Order placed; observed HTTP ${observations[0]!.status}.\nBase: ${context.instances[0]!.commit}. Evidence: base-checkout.json.`,
    )
    artifacts.push({ kind: 'note', title: 'Reproduction steps', path })
  }
  if (outcome === 'changes-needed')
    artifacts.push({
      kind: 'finding',
      title: 'Checkout scenario',
      content: `Scenario: Place order\nObserved: ${observations.map((o) => `${o.surface} HTTP ${o.status}`).join(', ')}\nExpected: base HTTP 500 (bug only), head HTTP 200 and Order placed\nEvidence: ${context.instances.at(-1)!.surface}-checkout.json`,
    })
  await writeFile(
    join(directory, 'result.json'),
    JSON.stringify({
      outcome,
      summary: 'Drove POST /checkout through the running HTTP application.',
      artifacts,
    }),
  )
}
