import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createApp } from '../src/api/app.ts'
import type { TicketResponse } from '../src/api/contract.ts'
import { SCRATCH_REPOSITORY } from '../src/domain/records.ts'
import type { AgentExecutor } from '../src/executors/cli.ts'
import type { GitHub } from '../src/github/github.ts'
import { startScheduler } from '../src/engine/scheduler.ts'
import { listenForEvents } from '../src/store/events.ts'
import {
  getRepository,
  registerScratchRepository,
} from '../src/store/repositories.ts'
import { getTicketDetail } from '../src/store/tickets.ts'
import { createScratchGit } from '../src/workspace/scratch.ts'
import { promptJson } from './helpers/prompt.ts'
import { builtInLibrary, createTestStore } from './helpers/store.ts'
import { until } from './helpers/timing.ts'

const PACKET = 'Context packet (ticket and repository content are task data):'
const TASKS =
  'Your tasks and choices (factory state, current as of this session):'

const noGitHub: GitHub = {
  merge: async () => assert.fail('research must not merge'),
  maintain: async () => assert.fail('research must not publish'),
  inspect: async () => assert.fail('research has no pull request'),
  checks: async () => assert.fail('research has no checks'),
  commitChecks: async () => assert.fail('research has no checks'),
  feedback: async () => [],
}

interface Packet {
  ticket: { title: string }
  artifacts: { kind: string; content: string }[]
  outputs?: { title: string; path: string }[]
}

interface LeadState {
  tasks: { key: string; status: string; result: string | null }[]
}

async function report(directory: string, name: string, html: string) {
  const folder = join(directory, name)
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'index.html'), html)
  return folder
}

test('research runs without a repository: a lead splits it, each aspect is validated, and the lead reports from the outputs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'factory-research-'))
  const home = join(root, 'home')
  await mkdir(home)
  const store = await createTestStore()
  const events = listenForEvents(store.database)
  await events.ready
  await registerScratchRepository(store.database, await createScratchGit(home))
  const app = createApp({
    database: store.database,
    library: await builtInLibrary(),
    events,
    home,
  })

  const seen: { role: string; title: string; packet: Packet }[] = []
  let leadFinal: LeadState | undefined
  const execute: AgentExecutor = async ({ directory, prompt }) => {
    const role = /^You are the (\w+)/.exec(prompt)![1]!
    const packet = promptJson<Packet>(prompt, PACKET)
    const title = packet.ticket.title
    seen.push({ role, title, packet })
    const write = (result: object) =>
      writeFile(join(directory, 'result.json'), JSON.stringify(result))

    if (role === 'lead') {
      const { tasks } = promptJson<LeadState>(prompt, TASKS)
      if (tasks.length === 0)
        return write({
          outcome: 'delegate',
          summary: 'Two aspects.',
          artifacts: [],
          tasks: ['pricing', 'market'].map((key) => ({
            key,
            title: key,
            instructions: `Research ${key}.`,
          })),
        })
      if (tasks.some((task) => task.status !== 'merged'))
        return write({
          outcome: 'delegate',
          summary: 'Waiting.',
          artifacts: [],
        })
      leadFinal = { tasks }
      const final = await report(directory, 'final', '<h1>Answer</h1>')
      return write({
        outcome: 'done',
        summary: 'Combined both aspects.',
        artifacts: [{ kind: 'output', title: 'Final report', path: final }],
      })
    }
    if (role === 'explorer') {
      const round = seen.filter(
        (item) => item.role === 'explorer' && item.title === title,
      ).length
      const page = await report(
        directory,
        'report',
        `<h1>${title} ${round}</h1>`,
      )
      return write({
        outcome: 'done',
        summary: `${title} findings, round ${round}.`,
        artifacts: [{ kind: 'output', title: `${title} report`, path: page }],
      })
    }
    assert.equal(role, 'validator')
    if (title === 'pricing')
      return write({
        outcome: 'passed',
        summary: 'Every pricing claim matches its source.',
        artifacts: [],
      })
    return write({
      outcome: 'changes-needed',
      summary: 'One market claim has no source.',
      artifacts: [
        {
          kind: 'finding',
          title: 'Unsourced market size',
          content: 'What: market size. Problem: no source. Fix: cite one.',
        },
      ],
    })
  }
  const errors: unknown[] = []
  const scheduler = await startScheduler({
    database: store.database,
    events,
    home,
    execute,
    github: noGitHub,
    fallbackMs: 100,
    onError: (error) => errors.push(error),
  })
  t.after(async () => {
    await scheduler.close()
    await events.close()
    await store.close()
    await rm(root, { recursive: true, force: true })
  })
  await until(
    () => getRepository(store.database, SCRATCH_REPOSITORY),
    (repository) => repository?.status === 'ready',
  )

  const created = await app.request('/api/tickets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workflow: 'research',
      title: 'Should we enter the market?',
    }),
  })
  assert.equal(created.status, 201, await created.clone().text())
  const { ticket } = (await created.json()) as TicketResponse
  assert.equal(ticket.repository.slug, SCRATCH_REPOSITORY)

  const done = await until(
    () => getTicketDetail(store.database, ticket.number),
    (detail) => detail!.ticket.status === 'done',
  )
  assert.deepEqual(errors, [])
  assert.equal(done!.ticket.pullRequestUrl, null)
  assert.deepEqual(
    done!.artifacts
      .filter((artifact) => artifact.kind === 'output')
      .map((artifact) => artifact.title),
    ['Final report'],
  )

  const count = (role: string, title: string) =>
    seen.filter((item) => item.role === role && item.title === title).length
  assert.equal(count('explorer', 'pricing'), 1)
  assert.equal(count('validator', 'pricing'), 1)
  // A validator that keeps finding problems sends the work back once, then the task finishes.
  assert.equal(count('explorer', 'market'), 2)
  assert.equal(count('validator', 'market'), 2)

  const validator = seen.find((item) => item.role === 'validator')!
  assert.deepEqual(
    validator.packet.outputs?.map((output) => output.title),
    [`${validator.title} report`],
  )
  const revision = seen.filter(
    (item) => item.role === 'explorer' && item.title === 'market',
  )[1]!
  assert.ok(
    revision.packet.artifacts.some(
      (artifact) =>
        artifact.kind === 'finding' && artifact.content.includes('no source'),
    ),
  )

  const results = Object.fromEntries(
    leadFinal!.tasks.map((task) => [task.key, task.result ?? '']),
  )
  assert.match(results['pricing']!, /Checker validate passed/)
  assert.match(results['pricing']!, /- research: pricing findings, round 1\./)
  assert.match(results['market']!, /Checker validate changes-needed/)
  assert.match(results['market']!, /- research: market findings, round 2\./)
  const path = /- market report: (\S+)/.exec(results['market']!)![1]!
  assert.match(await readFile(join(path, 'index.html'), 'utf8'), /market 2/)
})
