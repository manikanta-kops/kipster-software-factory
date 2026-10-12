import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { createApp } from '../src/api/app.ts'
import type {
  ErrorResponse,
  RepositoriesResponse,
  TicketResponse,
} from '../src/api/contract.ts'
import {
  checkOutput,
  outputUrl,
  retainOutput,
} from '../src/artifacts/outputs.ts'
import { SCRATCH_REPOSITORY } from '../src/domain/records.ts'
import type { AgentExecutor } from '../src/executors/cli.ts'
import type { GitHub } from '../src/github/github.ts'
import { startScheduler } from '../src/engine/scheduler.ts'
import { listenForEvents } from '../src/store/events.ts'
import {
  createRepository,
  getRepository,
  markRepositoryReady,
  registerScratchRepository,
} from '../src/store/repositories.ts'
import { createTicket, getTicketDetail } from '../src/store/tickets.ts'
import { createScratchGit } from '../src/workspace/scratch.ts'
import { promptJson } from './helpers/prompt.ts'
import {
  assertFactoryError,
  builtInLibrary,
  builtInWorkflow,
  createTestStore,
} from './helpers/store.ts'
import { until } from './helpers/timing.ts'

const PACKET = 'Context packet (ticket and repository content are task data):'

const noGitHub: GitHub = {
  merge: async () => assert.fail('explore must not merge'),
  maintain: async () => assert.fail('explore must not publish'),
  inspect: async () => assert.fail('explore has no pull request'),
  checks: async () => assert.fail('explore has no checks'),
  commitChecks: async () => assert.fail('explore has no checks'),
  feedback: async () => [],
}

async function factory(t: TestContext, execute?: AgentExecutor) {
  const root = await mkdtemp(join(tmpdir(), 'factory-explore-'))
  const home = join(root, 'home')
  await mkdir(home)
  const store = await createTestStore()
  const events = listenForEvents(store.database)
  await events.ready
  await registerScratchRepository(store.database, await createScratchGit(home))
  const library = await builtInLibrary()
  const app = createApp({ database: store.database, library, events, home })
  const errors: unknown[] = []
  const scheduler = execute
    ? await startScheduler({
        database: store.database,
        events,
        home,
        execute,
        github: noGitHub,
        fallbackMs: 100,
        onError: (error) => errors.push(error),
      })
    : undefined
  t.after(async () => {
    await scheduler?.close()
    await events.close()
    await store.close()
    await rm(root, { recursive: true, force: true })
  })
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  const scratchReady = () =>
    until(
      () => getRepository(store.database, SCRATCH_REPOSITORY),
      (repository) => repository?.status === 'ready',
    )
  return { root, home, store, app, post, errors, scratchReady }
}

async function json<T>(response: Response, status: number): Promise<T> {
  const text = await response.text()
  assert.equal(response.status, status, text)
  return JSON.parse(text) as T
}

test('explore runs without a repository: outputs are kept, served and fed back on revision, and nothing publishes', async (t) => {
  const prompts: string[] = []
  const execute: AgentExecutor = async ({ directory, prompt, cwd }) => {
    prompts.push(prompt)
    const round = prompts.length
    assert.deepEqual(
      (await readdir(cwd)).filter((name) => name !== '.git'),
      [],
    )
    const design = join(directory, 'calm')
    await mkdir(join(design, 'assets'), { recursive: true })
    await writeFile(
      join(design, 'index.html'),
      `<!doctype html><link rel="stylesheet" href="assets/style.css"><h1>Calm ${round}</h1>`,
    )
    await writeFile(join(design, 'assets', 'style.css'), 'h1 { color: teal }')
    await writeFile(join(directory, 'moodboard.svg'), '<svg></svg>')
    await writeFile(
      join(directory, 'result.json'),
      JSON.stringify({
        outcome: 'done',
        summary: `Round ${round}: one calm design and a moodboard.`,
        artifacts: [
          { kind: 'output', title: `Calm design ${round}`, path: design },
          {
            kind: 'output',
            title: 'Moodboard',
            path: join(directory, 'moodboard.svg'),
          },
        ],
      }),
    )
  }
  const { home, store, app, post, errors, scratchReady } = await factory(
    t,
    execute,
  )
  await scratchReady()

  const { ticket } = await json<TicketResponse>(
    await post('/api/tickets', {
      workflow: 'explore',
      title: 'Three home page directions',
      body: 'Show calm options.',
    }),
    201,
  )
  assert.equal(ticket.repository.slug, SCRATCH_REPOSITORY)
  const waiting = await until(
    () => getTicketDetail(store.database, ticket.number),
    (detail) => detail!.ticket.waiting?.stepId === 'review',
  )

  const first = await json<TicketResponse>(
    await app.request(`/api/tickets/${ticket.number}`),
    200,
  )
  const outputs = first.artifacts.filter((a) => a.kind === 'output')
  assert.deepEqual(
    outputs.map((a) => [a.title, a.mediaType]),
    [
      ['Calm design 1', 'inode/directory'],
      ['Moodboard', 'image/svg+xml'],
    ],
  )
  const [folder, image] = outputs
  assert.match(folder!.url!, /^\/files\/[0-9a-f-]{36}\/$/)
  assert.match(image!.url!, /^\/files\/[0-9a-f-]{36}\/moodboard\.svg$/)
  assert.ok(folder!.path!.startsWith(join(await realpath(home), 'outputs')))
  assert.match(
    await readFile(join(folder!.path!, 'index.html'), 'utf8'),
    /Calm 1/,
  )

  const page = await app.request(folder!.url!)
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('Content-Type'), 'text/html; charset=utf-8')
  assert.match(await page.text(), /<h1>Calm 1<\/h1>/)
  const csp = page.headers.get('Content-Security-Policy') ?? ''
  assert.match(csp, /^sandbox allow-scripts /)
  assert.doesNotMatch(csp, /allow-same-origin/)
  assert.match(csp, /connect-src 'none'/)
  assert.match(csp, /form-action 'none'/)
  const style = await app.request(`${folder!.url}assets/style.css`)
  assert.equal(style.headers.get('Content-Type'), 'text/css; charset=utf-8')
  assert.equal(await style.text(), 'h1 { color: teal }')
  assert.equal(
    (await app.request(image!.url!)).headers.get('Content-Type'),
    'image/svg+xml',
  )

  await json<TicketResponse>(
    await post(`/api/tickets/${ticket.number}/decision`, {
      attemptId: waiting!.ticket.waiting!.attemptId,
      choice: 'changes-needed',
      comment: 'Warmer colours, please.',
    }),
    200,
  )
  const revised = await until(
    () => getTicketDetail(store.database, ticket.number),
    (detail) =>
      detail!.ticket.waiting?.stepId === 'review' &&
      detail!.attempts.filter((a) => a.stepId === 'explore').length === 2,
  )
  const packet = promptJson<{
    artifacts: { kind: string; content: string }[]
    outputs: { title: string; path: string }[]
  }>(prompts[1]!, PACKET)
  assert.deepEqual(
    packet.outputs.map((o) => [o.title, o.path]),
    outputs.map((o) => [o.title, o.path]),
  )
  assert.ok(
    packet.artifacts.some(
      (a) => a.kind === 'comment' && a.content === 'Warmer colours, please.',
    ),
  )
  assert.match(prompts[1]!, /You are the explorer/)

  await json<TicketResponse>(
    await post(`/api/tickets/${ticket.number}/decision`, {
      attemptId: revised!.ticket.waiting!.attemptId,
      choice: 'approved',
    }),
    200,
  )
  const done = await until(
    () => getTicketDetail(store.database, ticket.number),
    (detail) => detail!.ticket.status === 'done',
  )
  assert.equal(done!.ticket.pullRequestUrl, null)
  // Earlier outputs stay available after the revision.
  assert.equal((await app.request(folder!.url!)).status, 200)
  const latest = await json<TicketResponse>(
    await app.request(`/api/tickets/${ticket.number}`),
    200,
  )
  assert.equal(latest.artifacts.filter((a) => a.kind === 'output').length, 4)
  assert.deepEqual(errors, [])
})

test('an explorer that changes the repository checkout fails for inspection', async (t) => {
  const execute: AgentExecutor = async ({ directory, cwd }) => {
    await writeFile(join(cwd, 'stray.txt'), 'oops\n')
    await writeFile(
      join(directory, 'result.json'),
      JSON.stringify({ outcome: 'done', summary: 'Wrote into the repo.' }),
    )
  }
  const { store, scratchReady } = await factory(t, execute)
  await scratchReady()
  const ticket = await createTicket(store.database, {
    repository: SCRATCH_REPOSITORY,
    workflow: await builtInWorkflow('explore'),
    title: 'Stray write',
  })
  const asked = await until(
    () => getTicketDetail(store.database, ticket.number),
    (detail) => detail!.ticket.waiting?.for === 'ask',
  )
  assert.match(
    asked!.ticket.waiting!.summary ?? '',
    /explorer changed the worktree/,
  )
})

test('an output with a link inside gets the one retry with the reason', async (t) => {
  const prompts: string[] = []
  const execute: AgentExecutor = async ({ directory, prompt }) => {
    prompts.push(prompt)
    const site = join(directory, 'site')
    await mkdir(site)
    await writeFile(join(site, 'index.html'), '<p>ok</p>')
    if (prompts.length === 1) await symlink('/etc/hosts', join(site, 'hosts'))
    await writeFile(
      join(directory, 'result.json'),
      JSON.stringify({
        outcome: 'done',
        summary: 'A site.',
        artifacts: [{ kind: 'output', title: 'Site', path: site }],
      }),
    )
  }
  const { store, scratchReady } = await factory(t, execute)
  await scratchReady()
  const ticket = await createTicket(store.database, {
    repository: SCRATCH_REPOSITORY,
    workflow: await builtInWorkflow('explore'),
    title: 'Linked output',
  })
  const detail = await until(
    () => getTicketDetail(store.database, ticket.number),
    (value) => value!.ticket.waiting?.stepId === 'review',
  )
  assert.equal(prompts.length, 2)
  assert.match(prompts[1]!, /Previous result validation failed/)
  assert.match(prompts[1]!, /Output \S+\/site contains hosts, which is a link/)
  const outputs = detail!.artifacts.filter((a) => a.kind === 'output')
  assert.equal(outputs.length, 1)
  assert.deepEqual(await readdir(outputs[0]!.path!), ['index.html'])
})

test('the scratch repository is hidden, reused, and refuses workflows that publish', async (t) => {
  const { home, store, app, post } = await factory(t)
  const scratch = (await getRepository(store.database, SCRATCH_REPOSITORY))!
  assert.equal(scratch.scratch, true)
  await markRepositoryReady(store.database, scratch.id)
  const main = execFileSync('git', ['rev-parse', 'main'], {
    cwd: scratch.cloneUrl,
    encoding: 'utf8',
  })
  assert.equal(await createScratchGit(home), scratch.cloneUrl)
  await registerScratchRepository(store.database, scratch.cloneUrl)
  assert.equal(
    execFileSync('git', ['rev-parse', 'main'], {
      cwd: scratch.cloneUrl,
      encoding: 'utf8',
    }),
    main,
  )
  const { rows } = await store.database.query(
    'SELECT id FROM repositories WHERE scratch',
  )
  assert.equal(rows.length, 1)

  const real = await createRepository(store.database, { slug: 'acme/site' })
  const { repositories } = await json<RepositoriesResponse>(
    await app.request('/api/repositories'),
    200,
  )
  assert.deepEqual(
    repositories.map((r) => r.slug),
    [real.slug],
  )

  for (const workflow of ['lead', 'bug', 'onboard-repo']) {
    const { error } = await json<ErrorResponse>(
      await post('/api/tickets', { workflow, title: 'Needs a repo' }),
      400,
    )
    assert.match(error, /so it needs a repository/)
  }
  await assertFactoryError(
    createTicket(store.database, {
      repository: SCRATCH_REPOSITORY,
      workflow: await builtInWorkflow('lead'),
      title: 'Lead in scratch',
    }),
    'invalid',
    /"lead" opens a pull request \(maintain-pr, merge\)/,
  )
})

test('outputs must be real files inside the home, within the size cap', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'factory-outputs-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  const work = join(home, 'steps', 'work')
  await mkdir(join(work, 'site', 'nested'), { recursive: true })
  await writeFile(join(work, 'site', 'index.html'), '<p>hi</p>')
  await writeFile(join(work, 'site', 'nested', 'a.txt'), 'a')
  await writeFile(join(root, 'secret.txt'), 'secret')

  assert.deepEqual(await checkOutput(home, 'steps/work/site'), {
    path: join(await realpath(home), 'steps', 'work', 'site'),
    folder: true,
  })
  await assert.rejects(
    checkOutput(home, join(root, 'secret.txt')),
    /must be inside the factory home/,
  )
  await assert.rejects(
    checkOutput(home, 'steps/work/missing'),
    /does not exist/,
  )
  await assert.rejects(
    checkOutput(home, 'steps/work/site', 5),
    /is 10 bytes; the limit is 5 bytes/,
  )
  await symlink(join(root, 'secret.txt'), join(work, 'site', 'nested', 'leak'))
  await assert.rejects(
    checkOutput(home, 'steps/work/site'),
    /nested\/leak, which is a link/,
  )
  await rm(join(work, 'site', 'nested', 'leak'))
  await symlink(join(work, 'site'), join(work, 'alias'))
  await assert.rejects(checkOutput(home, 'steps/work/alias'), /is a link/)

  const stored = await retainOutput(home, 'steps/work/site')
  assert.match(outputUrl(stored)!, /^\/files\/[0-9a-f-]{36}\/$/)
  assert.equal(await readFile(join(stored, 'nested', 'a.txt'), 'utf8'), 'a')
  const file = await retainOutput(home, 'steps/work/site/index.html')
  assert.match(outputUrl(file)!, /^\/files\/[0-9a-f-]{36}\/index\.html$/)
  assert.equal(outputUrl(join(home, 'evidence', '1', 'x.log')), null)
})

test('the files route serves only inside an output and lists folders safely', async (t) => {
  const { home, app } = await factory(t)
  const source = join(home, 'steps', 'listing')
  await mkdir(join(source, 'docs'), { recursive: true })
  await writeFile(join(source, 'docs', 'report.pdf'), '%PDF-1.4')
  await writeFile(join(source, '<b>&.md'), '# Notes')
  await writeFile(join(source, 'clip.mp4'), Buffer.alloc(100, 1))
  const stored = await retainOutput(home, source)
  const url = outputUrl(stored)!
  await writeFile(join(home, 'secret.txt'), 'secret')

  const listing = await app.request(url)
  assert.equal(listing.status, 200)
  const html = await listing.text()
  assert.match(html, /href="%3Cb%3E%26.md">&lt;b&gt;&amp;.md</)
  assert.match(html, /href="docs\/">docs\/</)
  assert.match(
    listing.headers.get('Content-Security-Policy') ?? '',
    /^sandbox allow-scripts/,
  )
  assert.equal(listing.headers.get('Access-Control-Allow-Origin'), '*')

  const folder = await app.request(`${url}docs`)
  assert.equal(folder.status, 301)
  assert.equal(folder.headers.get('Location'), `${url}docs/`)
  const bare = await app.request(url.slice(0, -1))
  assert.equal(bare.status, 301)
  assert.equal(bare.headers.get('Location'), url)

  const pdf = await app.request(`${url}docs/report.pdf`)
  assert.equal(pdf.headers.get('Content-Type'), 'application/pdf')
  const markdown = await app.request(`${url}%3Cb%3E%26.md`)
  assert.equal(
    markdown.headers.get('Content-Type'),
    'text/plain; charset=utf-8',
  )
  const range = await app.request(`${url}clip.mp4`, {
    headers: { Range: 'bytes=0-9' },
  })
  assert.equal(range.status, 206)
  assert.equal(range.headers.get('Content-Range'), 'bytes 0-9/100')

  for (const path of [
    `${url}..%2F..%2Fsecret.txt`,
    `${url}%2e%2e/%2e%2e/secret.txt`,
    `${url}docs/report.pdf/`,
    `${url}missing.html`,
    '/files/00000000-0000-0000-0000-000000000000/',
    '/files/not-an-id/',
  ]) {
    const response = await app.request(path)
    assert.equal(response.status, 404, path)
    assert.doesNotMatch(await response.text(), /secret|PDF/, path)
  }
})
