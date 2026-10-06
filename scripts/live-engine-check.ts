// Runs only when explicitly invoked: two real CLI sessions in a throwaway clone, never pushes.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { engineConfig } from '../src/config.ts'
import { buildPrompt, readResult } from '../src/engine/prompt.ts'
import { executeAgent } from '../src/executors/cli.ts'
import { run } from '../src/executors/process.ts'
import { loadTrustedInstructions } from '../src/kit/kit.ts'
import type { TicketDetail } from '../src/store/tickets.ts'

const source =
  process.argv[2] ??
  join(homedir(), 'Documents/WorkArea/github/kipster-factory-floor')
const home = await mkdtemp(join(tmpdir(), 'factory-engine-live-'))
const cwd = join(home, 'clone')
console.log(`Live check evidence: ${home}`)
await run('git', ['clone', '--no-hardlinks', '--', source, cwd])
await run('git', ['remote', 'remove', 'origin'], { cwd })
await run('git', ['switch', '-c', 'kipster/0-engine-smoke-check'], { cwd })
const initial = await run('git', ['rev-parse', 'HEAD'], { cwd })
const now = new Date().toISOString()
const detail: TicketDetail = {
  dependencies: [],
  links: [],
  tasks: [],
  parentTask: null,
  ticket: {
    lightsOut: false,
    id: 0,
    number: 0,
    repository: { id: 0, slug: 'local/throwaway' },
    workflow: { name: 'live-check', version: 'local' },
    title: 'Document the factory engine smoke check',
    body: 'In this throwaway clone only, add ENGINE_SMOKE_CHECK.md containing the exact sentence "Factory engine smoke check." and a short explanation that this file verifies planner and builder execution. Acceptance: the file exists, contains that sentence, and is committed. Do not push, open a PR, or change any other tracked files. Follow AGENTS.md verification instructions. This task is explicitly authorized.',
    branch: 'kipster/0-engine-smoke-check',
    pullRequestUrl: null,
    currentStep: 'plan',
    status: 'running',
    waiting: null,
    createdAt: now,
    updatedAt: now,
  },
  workflow: {
    name: 'live-check',
    description: 'Explicit CLI smoke check',
    steps: [],
  },
  attempts: [],
  artifacts: [],
  events: [],
}
for (const role of ['planner', 'builder'] as const) {
  const directory = join(home, role)
  await mkdir(directory)
  const step = { kind: 'agent' as const, id: role, role, routes: {}, needs: [] }
  const prompt = await buildPrompt({
    step,
    detail,
    directory,
    home,
    trusted: await loadTrustedInstructions(cwd, initial, role),
    diff: await run('git', ['diff', '--stat', `${initial}...HEAD`], { cwd }),
  })
  await writeFile(join(directory, 'prompt.md'), prompt)
  await executeAgent({
    config: engineConfig.parse({}).agents.default,
    cwd,
    directory,
    prompt,
    log: join(directory, 'agent.log'),
    signal: AbortSignal.timeout(10 * 60_000),
  })
  const result = await readResult(directory, role, home)
  assert.equal(result.outcome, 'done')
  console.log(
    `${role}: valid result.json, ${result.outcome}: ${result.summary}`,
  )
  if (role === 'planner') {
    assert.equal(await run('git', ['rev-parse', 'HEAD'], { cwd }), initial)
    assert.equal(await run('git', ['status', '--porcelain'], { cwd }), '')
    Object.assign(detail, {
      artifacts: result.artifacts.map((artifact, index) => ({
        ...artifact,
        id: index + 1,
        ticketId: 0,
        attemptId: 1,
        stepId: 'planner',
        content: artifact.content ?? null,
        path: artifact.path ?? null,
        createdAt: now,
      })),
      attempts: [
        {
          id: 2,
          stepId: 'approval',
          waitingFor: 'human',
          outcome: 'approved',
          summary: 'Approved for this explicit live smoke check.',
        },
      ],
    })
  }
}
assert.match(
  await readFile(join(cwd, 'ENGINE_SMOKE_CHECK.md'), 'utf8'),
  /Factory engine smoke check\./,
)
assert.notEqual(await run('git', ['rev-parse', 'HEAD'], { cwd }), initial)
assert.equal(await run('git', ['status', '--porcelain'], { cwd }), '')
console.log(
  `PASS: planner did not commit; builder committed the requested file. No remote configured. Evidence retained at ${home}`,
)
