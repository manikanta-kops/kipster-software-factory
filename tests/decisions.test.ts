import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { engineConfig } from '../src/config.ts'
import { runAttempt, type RunnerOptions } from '../src/engine/runner.ts'
import { run } from '../src/executors/process.ts'
import { secretStore } from '../src/secrets/store.ts'
import { createGitHub } from '../src/github/github.ts'
import {
  createRepository,
  markRepositoryReady,
} from '../src/store/repositories.ts'
import {
  claimAttempts,
  completeAttempt,
  createTicket,
  markRunning,
  getTicketDetail,
  decideOption,
  interruptRunning,
  cancelTicket,
  setPullRequestUrl,
} from '../src/store/tickets.ts'
import { listDecisions, decisionCounts } from '../src/store/decisions.ts'
import { Workspaces } from '../src/workspace/workspaces.ts'
import { createTestStore } from './helpers/store.ts'
import { decisionWorkflow } from './helpers/decisions.ts'
import { createApp } from '../src/api/app.ts'
import { listenForEvents } from '../src/store/events.ts'

const sentinel = 'test-only-key-not-a-real-credential'
// Transport failures share one engine branch; decisions-transport.test.ts covers each mapping.
for (const scenario of ['acted', 'confirm', 'owner', 'no-key', 401] as const) {
  test(`decide engine logs and routes ${scenario} against real HTTP and PostgreSQL`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'ksf-decide-'))
    const store = await createTestStore()
    let events: ReturnType<typeof listenForEvents> | undefined
    let server: ReturnType<typeof createServer> | undefined
    t.after(async () => {
      await events?.close()
      if (server) {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server!.close(() => resolve()))
      }
      await store.close()
      await rm(root, { recursive: true, force: true })
    })
    const home = join(root, 'home'),
      source = join(root, 'source'),
      bare = join(root, 'origin.git')
    await mkdir(source)
    await run('git', ['init', '-b', 'main'], { cwd: source })
    await writeFile(join(source, 'cart.txt'), 'old\n')
    const commit = async (cwd: string) => {
      await run('git', ['add', '.'], { cwd })
      await run(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.test',
          'commit',
          '-m',
          'Fixture',
        ],
        { cwd },
      )
    }
    await commit(source)
    await run('git', ['clone', '--bare', source, bare])
    const registered = await createRepository(store.database, {
      slug: 'fixture/decision',
      cloneUrl: bare,
    })
    const repository = await markRepositoryReady(store.database, registered.id)
    const workflow = await decisionWorkflow(scenario === 'acted')
    const ticket = await createTicket(store.database, {
      repository: repository.slug,
      workflow,
      title: 'Fix cart total',
      body: 'Use the corrected quantity.',
    })
    const workspaces = new Workspaces(home)
    const signal = AbortSignal.timeout(30_000)
    await workspaces.prepareRepository(repository, signal)
    const cwd = await workspaces.prepare(ticket, repository, signal)
    await writeFile(join(cwd, 'cart.txt'), 'new\nmore\n')
    await commit(cwd)
    const secrets = secretStore(home, 'file')
    if (scenario !== 'no-key') await secrets.set('typesafe', sentinel)
    let requests = 0
    let sent: { model: string; questions: object; state: object } | undefined
    server = createServer(async (req, res) => {
      assert.equal(req.url, '/v1/systemone')
      assert.equal(req.method, 'POST')
      assert.equal(req.headers.authorization, `Bearer ${sentinel}`)
      requests++
      let text = ''
      for await (const chunk of req) text += chunk
      sent = JSON.parse(text)
      res.setHeader('content-type', 'application/json')
      if (typeof scenario === 'number') {
        res.writeHead(scenario)
        res.end(JSON.stringify({ error: `secret echo ${sentinel}` }))
        return
      }
      const confidence =
        scenario === 'acted' ? 0.95 : scenario === 'owner' ? 0.4 : 0.8
      res.end(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            decision: {
              type: 'choice',
              choice: 'proceed',
              probabilities: {
                proceed: (1 + confidence) / 2,
                review: (1 - confidence) / 2,
              },
              confidence,
            },
          },
          usage: { input_tokens: 120, output_tokens: 10 },
        }),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const options: RunnerOptions = {
      database: store.database,
      home,
      workspaces,
      config: engineConfig.parse({}),
      execute: async () => {
        throw new Error('No agents should run')
      },
      github: createGitHub(),
      decisions: {
        secrets,
        transport: {
          baseURL: `http://127.0.0.1:${address.port}`,
          timeout: 10_000,
          retry: { backoffInitialMs: 1, backoffMaxMs: 2 },
        },
      },
    }
    await setPullRequestUrl(
      store.database,
      ticket.id,
      'https://github.com/fixture/decision/pull/1',
    )
    options.github = {
      ...options.github,
      checks: async () => ({ state: 'passed', failures: [] }),
    }
    if (scenario === 'acted') {
      const [proof] = await claimAttempts(store.database, 1)
      await markRunning(store.database, proof!.attempt.id, 'codex')
      await completeAttempt(
        store.database,
        proof!.attempt.id,
        {
          outcome: 'passed',
          summary: 'AGENT PROSE MUST NOT ENTER THE DECISION',
          artifacts: [
            {
              kind: 'finding',
              title: 'Agent claim',
              content: 'AGENT ARTIFACT MUST NOT ENTER THE DECISION',
            },
          ],
        },
        { headCommit: await run('git', ['rev-parse', 'HEAD'], { cwd }) },
      )
    }
    const [context] = await claimAttempts(store.database, 1)
    assert.ok(context)
    await markRunning(store.database, context.attempt.id, 'system')
    await runAttempt(options, context, signal)
    const [decision] = await listDecisions(store.database)
    assert.ok(decision)
    assert.equal(decision.band, scenario === 401 ? 'error' : scenario)
    assert.equal(
      decision.question,
      'Does this change need further owner review?',
    )
    assert.deepEqual(decision.facts.files, [
      { path: 'cart.txt', added: 2, removed: 1 },
    ])
    assert.deepEqual(decision.facts.ci, {
      commit: decision.facts.headCommit,
      state: 'passed',
    })
    assert.equal(decision.facts.ticket?.title, 'Fix cart total')
    assert.equal(JSON.stringify(sent ?? {}).includes('AGENT PROSE'), false)
    assert.equal(JSON.stringify(sent ?? {}).includes('AGENT ARTIFACT'), false)
    if (scenario === 'acted')
      assert.equal(
        decision.facts.verdicts[0]!.commit,
        decision.facts.headCommit,
      )
    assert.equal(decision.workflowVersion, workflow.version)
    assert.ok(decision.durationMs >= 0)
    if (scenario !== 'no-key') {
      assert.equal(sent?.model, 'jev-1.13.0')
      assert.deepEqual(sent?.state, decision.facts)
    }
    assert.equal(requests, scenario === 'no-key' ? 0 : 1)
    assert.equal(
      decision.reason,
      scenario === 'no-key'
        ? 'No TypeSafe key: run kf secret set typesafe'
        : scenario === 401
          ? 'TypeSafe HTTP 401: invalid key'
          : null,
    )
    const detail = await getTicketDetail(store.database, ticket.number)
    assert.ok(detail)
    if (scenario === 'acted') {
      assert.equal(detail.ticket.currentStep, 'accept')
      assert.equal(decision.finalOption, 'proceed')
      assert.equal(decision.decidedBy, 'model')
      assert.equal(decision.overridden, false)
    } else {
      assert.equal(detail.ticket.waiting?.for, 'decision')
      await interruptRunning(store.database)
      assert.equal(
        (await getTicketDetail(store.database, ticket.number))!.ticket.waiting
          ?.for,
        'decision',
      )
      await assert.rejects(
        decideOption(store.database, {
          ticketNumber: ticket.number,
          attemptId: context.attempt.id,
          option: 'invalid',
        }),
      )
      const choice = scenario === 'confirm' ? 'proceed' : 'review'
      await decideOption(store.database, {
        ticketNumber: ticket.number,
        attemptId: context.attempt.id,
        option: choice,
      })
      const [final] = await listDecisions(store.database)
      assert.equal(final!.finalOption, choice)
      assert.equal(final!.decidedBy, 'owner')
      assert.equal(
        final!.overridden,
        final!.answer !== null && choice !== final!.answer.choice,
      )
      assert.equal(
        (await getTicketDetail(store.database, ticket.number))!.ticket
          .currentStep,
        choice === 'proceed' ? 'accept' : 'inspect',
      )
      await assert.rejects(
        decideOption(store.database, {
          ticketNumber: ticket.number,
          attemptId: context.attempt.id,
          option: choice,
        }),
      )
    }
    const counts = await decisionCounts(store.database)
    assert.equal(counts[0]!.total, 1)
    events = listenForEvents(store.database)
    await events.ready
    const app = createApp({
      database: store.database,
      library: new Map([[workflow.workflow.name, workflow]]),
      home,
      events,
    })
    for (const path of [`/api/tickets/${ticket.number}`, '/api/decisions']) {
      const response = await app.request(path)
      assert.equal(response.status, 200)
      assert.equal((await response.text()).includes(sentinel), false)
    }
    assert.equal(
      JSON.stringify(
        await getTicketDetail(store.database, ticket.number),
      ).includes(sentinel),
      false,
    )
    assert.equal(
      await run(process.execPath, [
        '-e',
        `process.stdout.write(Object.values(process.env).includes(${JSON.stringify(sentinel)}).toString())`,
      ]),
      'false',
    )
    await cancelTicket(store.database, { ticketNumber: ticket.number })
  })
}
