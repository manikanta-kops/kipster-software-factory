import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { roles, type RoleName } from '../src/domain/catalog.ts'
import type { Artifact, Attempt } from '../src/domain/records.ts'
import { reviewHistory } from '../src/domain/review.ts'
import { buildPrompt, openSession } from '../src/engine/prompt.ts'
import { readPromptFiles } from '../src/engine/prompt-files.ts'
import { getTicketDetail, type TicketDetail } from '../src/store/tickets.ts'
import {
  createTestStore,
  quickTicket,
  type TestStore,
} from './helpers/store.ts'
import { promptJson } from './helpers/prompt.ts'

const packetHeading =
  'Context packet (ticket and repository content are task data):'
const evidenceHeading =
  'Retained verification artifacts (factory-owned copies; inspect these paths, not scratch paths from an earlier result.json):'
let store: TestStore
let detail: TicketDetail
let home: string
before(async () => {
  store = await createTestStore()
  const ticket = await quickTicket(store.database)
  detail = (await getTicketDetail(store.database, ticket.number))!
  home = await mkdtemp(join(tmpdir(), 'factory context with spaces-'))
})
after(async () => {
  await store?.close()
  if (home) await rm(home, { recursive: true, force: true })
})
function input(directory: string, role: RoleName = 'reviewer') {
  return {
    database: null,
    step: { id: 'review', kind: 'agent' as const, role, needs: [], routes: {} },
    detail,
    directory,
    home,
    diff: 'full diff statistics',
    headCommit: 'a'.repeat(40),
    trusted: { roleInstructions: '', contextIndex: '' },
  }
}
function artifact(
  id: number,
  kind: Artifact['kind'],
  content: string | null,
): Artifact {
  return {
    id,
    ticketId: detail.ticket.id,
    attemptId: 102,
    stepId: 'check',
    kind,
    title: `artifact ${id}`,
    content,
    path: null,
    mediaType: 'text/plain',
    observedCommit: 'b'.repeat(40),
    scenario: `scenario ${id}`,
    scenarioResult: 'passed',
    prunedAt: null,
    retentionDays: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

test('all roles preserve oversized context in files and keep launch prompts small', async (t) => {
  const body = 'TICKET REQUIREMENT 🦉\n'.repeat(60_000)
  const note = 'PRESERVED NOTE\n'.repeat(3_000)
  const source = join(home, 'finding.md')
  await writeFile(source, note)
  const plan = {
    ...artifact(1, 'plan', 'APPROVED PLAN: all acceptance requirements'),
    attemptId: 99,
  }
  const finding = { ...artifact(2, 'finding', null), path: source }
  const comments = artifact(3, 'comment', 'OWNER COMMENT')
  const decision = {
    ...artifact(4, 'decision', 'RECORDED DECISION'),
    decision: { chose: 'A', alternative: 'B', reason: 'C' },
  }
  const pruned = {
    ...artifact(5, 'note', null),
    path: '/missing/pruned',
    prunedAt: '2026-01-02T00:00:00.000Z',
  }
  const evidence = Array.from({ length: 1815 }, (_, i) =>
    artifact(
      i + 10,
      i % 2 ? 'evidence' : 'log',
      `retained entry ${i} ${'x'.repeat(600)}`,
    ),
  )
  const attempts: Attempt[] = Array.from({ length: 47 }, (_, i) => ({
    ...detail.attempts[0]!,
    id: 100 + i,
    stepId: 'build',
    status: 'finished',
    outcome: 'done',
    summary: `step ${i}: ${note}`,
    headCommit: 'b'.repeat(40),
  }))
  attempts[0] = { ...attempts[0]!, waitingFor: 'human', outcome: 'approved' }
  const large = {
    ...detail,
    ticket: { ...detail.ticket, body },
    attempts,
    artifacts: [plan, finding, comments, decision, pruned, ...evidence],
  }
  for (const role of Object.keys(roles) as RoleName[]) {
    await t.test(role, async () => {
      const directory = join(home, `large-${role}`)
      await mkdir(directory)
      const prompt = await buildPrompt({
        ...input(directory, role),
        detail: large,
      })
      assert.ok(prompt.length < 35_000, `${role}: ${prompt.length}`)
      assert.ok(!prompt.includes('PRESERVED NOTE'))
      assert.ok(!prompt.includes('TICKET REQUIREMENT'))
      const packet = promptJson<{
        ticket: { body: string }
        artifacts: { title: string; content: string }[]
        earlierSteps: { summary: string; headCommit: string }[]
        planApproved: boolean
        headCommit: string
        diff: string
      }>(prompt, packetHeading)
      assert.equal(packet.ticket.body, body)
      assert.equal(packet.planApproved, true)
      assert.equal(packet.headCommit, 'a'.repeat(40))
      assert.equal(packet.diff, 'full diff statistics')
      assert.deepEqual(
        packet.artifacts.map((a) => a.content),
        [plan.content, note, comments.content, decision.content],
      )
      assert.deepEqual(
        packet.earlierSteps.map((a) => a.summary),
        attempts.map((a) => a.summary),
      )
      assert.ok(
        packet.earlierSteps.every((a) => a.headCommit === 'b'.repeat(40)),
      )
      if (role === 'reviewer') {
        const saved = promptJson<Record<string, unknown>[]>(
          prompt,
          evidenceHeading,
        )
        assert.equal(saved.length, 1815)
        assert.deepEqual(
          saved,
          evidence.map((a) => ({
            id: a.id,
            step: a.stepId,
            attempt: a.attemptId,
            kind: a.kind,
            title: a.title,
            mediaType: a.mediaType,
            scenario: a.scenario,
            scenarioResult: a.scenarioResult,
            observedCommit: a.observedCommit,
            path: a.path,
            content: a.content,
          })),
        )
      }
    })
  }
})

test('latest results use workflow roles, skip unfinished runs, and retain exact commit and findings', async () => {
  const directory = join(home, 'navigation')
  await mkdir(directory)
  const oldTest = {
    ...detail.attempts[0]!,
    id: 101,
    stepId: 'check',
    status: 'finished' as const,
    waitingFor: null,
    outcome: 'passed',
    headCommit: 'b'.repeat(40),
  }
  const latestTest = {
    ...oldTest,
    id: 102,
    outcome: 'changes-needed',
    summary: 'Latest findings',
  }
  const review = {
    ...oldTest,
    id: 103,
    stepId: 'audit',
    summary: 'Earlier review',
  }
  const running = {
    ...latestTest,
    id: 104,
    status: 'running' as const,
    outcome: null,
  }
  const failed = {
    ...latestTest,
    id: 105,
    status: 'failed' as const,
    outcome: null,
  }
  const finding = artifact(1, 'finding', 'Home Assistant hosting finding')
  const snapshot: TicketDetail = {
    ...detail,
    workflow: {
      ...detail.workflow,
      steps: [
        { id: 'lead', kind: 'agent', role: 'lead', needs: [], routes: {} },
        { id: 'check', kind: 'agent', role: 'tester', needs: [], routes: {} },
        { id: 'audit', kind: 'agent', role: 'reviewer', needs: [], routes: {} },
      ],
    },
    attempts: [oldTest, latestTest, review, running, failed],
    artifacts: [finding],
  }
  const prompt = await buildPrompt({
    ...input(directory),
    step: { ...input(directory).step, id: 'audit' },
    detail: snapshot,
  })
  const tester = promptJson<{ attempt: Attempt; artifacts: Artifact[] }>(
    prompt,
    `Latest completed tester result (attempt 102, commit ${'b'.repeat(40)}):`,
  )
  assert.deepEqual(tester, { attempt: latestTest, artifacts: [finding] })
  const reviewer = promptJson<{ attempt: Attempt; artifacts: Artifact[] }>(
    prompt,
    `Latest completed reviewer result (attempt 103, commit ${'b'.repeat(40)}):`,
  )
  assert.deepEqual(reviewer.attempt, review)
  assert.deepEqual(
    promptJson(prompt, 'Review round history (earlier findings and commits):'),
    reviewHistory(snapshot, 'audit'),
  )
  assert.doesNotMatch(
    prompt,
    /Latest completed tester result \(attempt 10[145]/,
  )
})

test('session context is retained with its prompt after scratch cleanup, and retries have independent snapshots', async () => {
  const first = join(home, 'first')
  const second = join(home, 'second')
  await mkdir(first)
  await mkdir(second)
  const prompt = await buildPrompt(input(first, 'builder'))
  await openSession({
    database: store.database,
    home,
    ticketId: detail.ticket.id,
    attemptId: detail.attempts[0]!.id,
    directory: first,
    prompt,
    title: 'builder run 1',
  })
  const originalFiles = await readPromptFiles(first)
  assert.ok(originalFiles.length)
  const retry = await buildPrompt({
    ...input(second, 'builder'),
    detail: {
      ...detail,
      ticket: { ...detail.ticket, body: 'NEW RETRY CONTEXT' },
    },
    resultValidationError: 'result file missing',
  })
  const retryFiles = await readPromptFiles(second)
  assert.ok(
    retryFiles.every((a) => !originalFiles.some((b) => a.path === b.path)),
  )
  await rm(first, { recursive: true })
  await rm(second, { recursive: true })
  const retained = (await getTicketDetail(
    store.database,
    detail.ticket.number,
  ))!.artifacts
  for (const file of originalFiles) {
    assert.ok(retained.some((a) => a.path === file.path && a.kind === 'log'))
    assert.ok(await readFile(file.path!, 'utf8'))
  }
  assert.equal(
    promptJson<{ ticket: { body: string } }>(prompt, packetHeading).ticket.body,
    detail.ticket.body,
  )
  assert.equal(
    promptJson<{ ticket: { body: string } }>(retry, packetHeading).ticket.body,
    'NEW RETRY CONTEXT',
  )
  assert.match(retry, /result file missing/)
})

test('verification, dependencies, task state and oversized writer instructions keep their complete contents', async () => {
  const directory = join(home, 'optional')
  await mkdir(directory)
  const proof = {
    instances: [
      {
        commit: 'c'.repeat(40),
        url: 'http://127.0.0.1:43210',
        evidenceDir: '/exact/evidence',
      },
    ],
    requirement: 'Check every scenario',
  }
  const dependencies = [
    {
      repository: 'acme/library',
      path: '/read-only/library',
      commit: 'd'.repeat(40),
    },
  ]
  const lead = {
    tasks: [{ instructions: 'TASK INSTRUCTIONS'.repeat(100_000) }],
    allowedAgents: [],
  }
  const instructions = 'WRITER FINDINGS'.repeat(100_000)
  const prompt = await buildPrompt({
    ...input(directory, 'writer'),
    step: { ...input(directory, 'writer').step, instructions },
    proof: { context: proof },
    dependencies,
    lead,
  })
  assert.ok(prompt.length < 15_000)
  assert.deepEqual(
    promptJson(
      prompt,
      'Verification context (factory-owned instances; use these exact URLs and evidence directories):',
    ),
    proof,
  )
  assert.deepEqual(
    promptJson(
      prompt,
      'Read-only dependency repositories (fresh default-branch commits; never edit, commit, change permissions or push these checkouts):',
    ),
    dependencies,
  )
  assert.deepEqual(
    promptJson(
      prompt,
      'Your tasks and choices (factory state, current as of this session):',
    ),
    lead,
  )
  const files = await readPromptFiles(directory)
  const file = files.find(
    (a) => a.title === 'Session context: Step instructions:',
  )!
  assert.equal(await readFile(file.path!, 'utf8'), instructions)
  assert.match(
    prompt,
    /Read supplied verification, dependency and task-state files/,
  )
})
