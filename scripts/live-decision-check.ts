// Explicit opt-in: a real decision in a disposable factory against a local floor clone.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { engineConfig, defaultHome } from '../src/config.ts'
import { createApp } from '../src/api/app.ts'
import { runAttempt } from '../src/engine/runner.ts'
import { run } from '../src/executors/process.ts'
import { createGitHub } from '../src/github/github.ts'
import { secretStore } from '../src/secrets/store.ts'
import { listDecisions } from '../src/store/decisions.ts'
import { listenForEvents } from '../src/store/events.ts'
import {
  createRepository,
  markRepositoryReady,
} from '../src/store/repositories.ts'
import {
  claimAttempts,
  createTicket,
  getTicketDetail,
  markRunning,
} from '../src/store/tickets.ts'
import { Workspaces } from '../src/workspace/workspaces.ts'
import { createTestStore } from '../tests/helpers/store.ts'
import { decisionWorkflow } from '../tests/helpers/decisions.ts'

const source = process.argv[2]
if (!source)
  throw new Error(
    'Supply the local factory-floor repository path. Run through scripts/with-test-database.ts.',
  )
const credentialsHome = process.argv[3] ?? defaultHome()
const secrets = secretStore(credentialsHome)
if (!(await secrets.list()).some((item) => item.name === 'typesafe'))
  throw new Error(
    'Run npm run kf -- secret set typesafe in your own terminal before the live check.',
  )
const home = await mkdtemp('/tmp/ksf-live-decision-')
const bare = join(home, 'floor.git')
await run('git', ['clone', '--bare', '--no-hardlinks', '--', source, bare])
const store = await createTestStore()
const events = listenForEvents(store.database)
await events.ready
try {
  const registered = await createRepository(store.database, {
    slug: 'local/factory-floor',
    cloneUrl: bare,
  })
  const defaultBranch = await run('git', ['symbolic-ref', '--short', 'HEAD'], {
    cwd: bare,
  })
  const repository = await markRepositoryReady(store.database, registered.id, {
    defaultBranch,
  })
  const workflow = await decisionWorkflow()
  const ticket = await createTicket(store.database, {
    repository: repository.slug,
    workflow,
    title: 'Clarify the station completion count label',
    body: 'The station completion count should explicitly say the last 10 minutes are floor simulation time. Keep counting and persistence behavior unchanged. Independent proof and CI have not been run for this scratch change.',
  })
  const workspaces = new Workspaces(home)
  const signal = AbortSignal.timeout(120_000)
  await workspaces.prepareRepository(repository, signal)
  const cwd = await workspaces.prepare(ticket, repository, signal)
  const path = join(cwd, 'src/web/pages/StationsPage.tsx')
  const before = await readFile(path, 'utf8')
  const after = before.replace(
    'Completed · last 10 min',
    'Completed · last 10 floor min',
  )
  assert.notEqual(
    before,
    after,
    'Expected the current factory-floor completion label',
  )
  await writeFile(path, after)
  await run('git', ['add', 'src/web/pages/StationsPage.tsx'], { cwd })
  await run(
    'git',
    [
      '-c',
      'user.name=Live acceptance',
      '-c',
      'user.email=acceptance@example.test',
      'commit',
      '-m',
      'Clarify station count label in scratch clone',
    ],
    { cwd },
  )
  const [context] = await claimAttempts(store.database, 1)
  assert.ok(context)
  await markRunning(store.database, context.attempt.id, 'system')
  await runAttempt(
    {
      database: store.database,
      home,
      config: engineConfig.parse({}),
      workspaces,
      github: createGitHub(),
      execute: async () => {
        throw new Error('Live decision check never runs agents')
      },
      decisions: { secrets },
    },
    context,
    signal,
  )
  const [decision] = await listDecisions(store.database)
  assert.ok(decision?.answer, 'The live decision must return a model answer')
  const app = createApp({
    database: store.database,
    library: new Map([[workflow.workflow.name, workflow]]),
    events,
    home,
  })
  const responses = await Promise.all(
    [`/api/tickets/${ticket.number}`, '/api/decisions'].map(async (path) =>
      (await app.request(path)).text(),
    ),
  )
  const detail = await getTicketDetail(store.database, ticket.number)
  const auditKey = await secrets.get('typesafe')
  assert.ok(auditKey)
  assert.equal(
    JSON.stringify({ decision, detail, responses }).includes(auditKey),
    false,
    'Secret in database records or API response',
  )
  let scannedFiles = 0
  const scan = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'floor.git') continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await scan(path)
      else if (entry.isFile()) {
        assert.equal(
          (await readFile(path)).includes(Buffer.from(auditKey)),
          false,
          'Secret in scratch-home file',
        )
        scannedFiles++
      }
    }
  }
  await scan(home)
  const digest = createHash('sha256').update(auditKey).digest('hex')
  const childAudit = await run(process.execPath, [
    '-e',
    `const {createHash}=require('node:crypto'); process.stdout.write(Object.values(process.env).some(value=>createHash('sha256').update(value).digest('hex')===${JSON.stringify(digest)}).toString())`,
  ])
  assert.equal(childAudit, 'false', 'Secret in child-process environment')
  const report = {
    question: decision.question,
    facts: decision.facts,
    model: decision.answer.model,
    choice: decision.answer.choice,
    probabilities: decision.answer.probabilities,
    confidence: decision.answer.confidence,
    band: decision.band,
    usage: decision.answer.usage,
    durationMs: decision.durationMs,
    audit: {
      backend: (await secrets.list()).find((item) => item.name === 'typesafe')
        ?.backend,
      databaseAndApi: 'no key found',
      scratchFiles: scannedFiles,
      scratchFilesResult: 'no key found',
      childEnvironment: 'no key found',
    },
  }
  await mkdir(join(home, 'acceptance'), { recursive: true })
  await writeFile(
    join(home, 'acceptance', 'decision.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  )
  console.log(JSON.stringify(report, null, 2))
  console.log(
    `Scratch evidence retained at ${home}. No push, PR publication or agent execution occurred.`,
  )
} finally {
  await events.close()
  await store.close()
}
