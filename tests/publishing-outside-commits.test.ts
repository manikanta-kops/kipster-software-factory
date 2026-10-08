import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { engineConfig } from '../src/config.ts'
import type { Workflow } from '../src/domain/workflow.ts'
import { maintainPullRequest } from '../src/engine/pull-requests.ts'
import type { RunnerOptions } from '../src/engine/runner.ts'
import { run } from '../src/executors/process.ts'
import { createGitHub, type PullRequest } from '../src/github/github.ts'
import { workflowVersion } from '../src/library/library.ts'
import {
  createRepository,
  markRepositoryReady,
} from '../src/store/repositories.ts'
import {
  claimAttempts,
  completeAttempt,
  createTicket,
  getTicketDetail,
  markRunning,
} from '../src/store/tickets.ts'
import { isLatestTesterVerdictCurrent } from '../src/store/verdicts.ts'
import { Workspaces } from '../src/workspace/workspaces.ts'
import { createTestStore } from './helpers/store.ts'

const signal = new AbortController().signal
async function fixture(
  t: TestContext,
  role: 'tester' | 'reviewer' = 'tester',
  prState: PullRequest['state'] = 'OPEN',
) {
  const root = await mkdtemp(join(tmpdir(), 'publishing-outside-'))
  const store = await createTestStore()
  t.after(async () => {
    await store.close()
    await rm(root, { recursive: true, force: true })
  })
  const home = join(root, 'home')
  const source = join(root, 'source')
  const bare = join(root, 'origin.git')
  await mkdir(home)
  const git = (cwd: string, args: string[]) => run('git', args, { cwd, signal })
  const commit = async (
    cwd: string,
    path: string,
    subject: string,
    author = 'Fixture',
  ) => {
    await writeFile(join(cwd, path), subject)
    await git(cwd, ['add', path])
    await git(cwd, [
      '-c',
      `user.name=${author}`,
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      subject,
    ])
    return git(cwd, ['rev-parse', 'HEAD'])
  }
  await run('git', ['init', '-b', 'main', source])
  await commit(source, 'README.md', 'initial')
  await run('git', ['clone', '--bare', source, bare])
  await git(bare, ['config', 'receive.denyNonFastForwards', 'true'])
  const repository = await createRepository(store.database, {
    slug: 'fixture/repo',
    cloneUrl: bare,
  })
  await markRepositoryReady(store.database, repository.id)
  const workflow: Workflow = {
    name: 'publishing-outside',
    description: 'Verify before publishing',
    steps: [
      { id: 'verify', kind: 'agent', role, needs: [], routes: {} },
      {
        id: 'publish',
        kind: 'system',
        action: 'maintain-pr',
        needs: [],
        with: { ciSettleMinutes: 0 },
        routes: { 'base-moved': 'verify' },
      },
      {
        id: 'merge',
        kind: 'system',
        action: 'merge',
        needs: [],
        with: {},
        routes: {},
      },
    ],
  }
  const sourceText = JSON.stringify(workflow)
  const ticket = await createTicket(store.database, {
    repository: repository.slug,
    title: 'Keep outside commits',
    workflow: {
      workflow,
      source: sourceText,
      version: workflowVersion(sourceText),
    },
  })
  const workspaces = new Workspaces(home)
  await workspaces.prepareRepository(repository, signal)
  const cwd = await workspaces.prepare(ticket, repository, signal)
  const head = await commit(cwd, 'ticket.txt', 'ticket change')
  const ghCalls: (readonly string[])[] = []
  const github = createGitHub(async (command, args) => {
    assert.equal(command, 'gh')
    ghCalls.push(args)
    if (args[1] === 'list')
      return JSON.stringify([
        {
          url: 'https://github.com/fixture/repo/pull/1',
          state: prState,
          headRepositoryOwner: { login: 'fixture' },
        },
      ])
    if (args[1] === 'create') return 'https://github.com/fixture/repo/pull/2'
    assert.equal(args[1], 'edit')
    return ''
  })
  github.checks = async () => ({ state: 'none', failures: [] })
  github.feedback = async () => []
  github.inspect = async (_repository, url) => ({
    url,
    state: 'OPEN',
    isDraft: false,
    baseRefName: 'main',
    mergeable: 'MERGEABLE',
    headRefOid: await git(bare, ['rev-parse', ticket.branch]),
  })
  let writers = 0
  const options: RunnerOptions = {
    database: store.database,
    home,
    config: engineConfig.parse({}),
    workspaces,
    github,
    execute: async (invocation) => {
      writers++
      await writeFile(
        join(invocation.directory, 'result.json'),
        JSON.stringify({
          outcome: 'done',
          summary: 'Description written',
          artifacts: [
            { kind: 'note', title: 'PR description', content: 'Ready' },
          ],
        }),
      )
    },
  }
  const next = async () => {
    const [context] = await claimAttempts(store.database, 1)
    assert.ok(context)
    await markRunning(store.database, context.attempt.id, 'system')
    return context
  }
  const verify = async (verifiedHead: string) => {
    const context = await next()
    assert.equal(context.step.id, 'verify')
    await completeAttempt(
      store.database,
      context.attempt.id,
      { outcome: 'passed', summary: 'Commit verified', artifacts: [] },
      { headCommit: verifiedHead },
    )
  }
  await verify(head)
  const trace = join(root, 'git.trace')
  return {
    root,
    cwd,
    bare,
    source,
    ticket,
    head,
    git,
    commit,
    verify,
    ghCalls,
    writers: () => writers,
    detail: async () => (await getTicketDetail(store.database, ticket.number))!,
    verdictCurrent: (observedHead: string) =>
      isLatestTesterVerdictCurrent(store.database, ticket.id, observedHead),
    async outside() {
      await git(cwd, ['push', 'origin', ticket.branch])
      const outside = join(root, 'outside')
      await run('git', ['clone', '--branch', ticket.branch, bare, outside])
      return outside
    },
    async publish() {
      const context = await next()
      assert.equal(context.step.id, 'publish')
      const previousTrace = process.env['GIT_TRACE']
      process.env['GIT_TRACE'] = trace
      try {
        // No workspace refresh here: the action itself must fetch new remote commits.
        await maintainPullRequest(options, context, cwd, signal)
      } finally {
        if (previousTrace === undefined) delete process.env['GIT_TRACE']
        else process.env['GIT_TRACE'] = previousTrace
      }
      return readFile(trace, 'utf8')
    },
  }
}

for (const diverged of [false, true]) {
  test(`outside commits preserve history and force re-test before publishing (${diverged ? 'diverged' : 'fast-forward'})`, async (t) => {
    const f = await fixture(t)
    const outside = await f.outside()
    const remote = await f.commit(
      outside,
      'outside.txt',
      'human work',
      'Outside Author',
    )
    await f.git(outside, ['push', 'origin', f.ticket.branch])
    const local = diverged
      ? await f.commit(f.cwd, 'local.txt', 'more ticket work')
      : f.head
    let trace = await f.publish()
    const merged = await f.git(f.cwd, ['rev-parse', 'HEAD'])
    assert.notEqual(merged, local)
    await f.git(f.cwd, ['merge-base', '--is-ancestor', remote, merged])
    await f.git(f.cwd, ['merge-base', '--is-ancestor', local, merged])
    if (diverged) {
      assert.equal(await f.git(f.cwd, ['rev-parse', 'HEAD^1']), local)
      assert.equal(await f.git(f.cwd, ['rev-parse', 'HEAD^2']), remote)
    }
    const detail = await f.detail()
    assert.equal(detail.attempts.at(-2)!.outcome, 'base-moved')
    assert.equal(detail.attempts.at(-2)!.headCommit, merged)
    assert.equal(detail.ticket.currentStep, 'verify')
    assert.equal(await f.verdictCurrent(merged), false)
    assert.equal(f.writers(), 0)
    assert.equal(f.ghCalls.length, 0)
    assert.doesNotMatch(trace, /built-in: git push /)
    assert.equal(await f.git(f.bare, ['rev-parse', f.ticket.branch]), remote)
    await f.verify(merged)
    trace = await f.publish()
    assert.equal((await f.detail()).attempts.at(-2)!.outcome, 'ready')
    const pushed = await f.git(f.bare, ['rev-parse', f.ticket.branch])
    assert.equal(pushed, merged)
    await f.git(f.bare, ['merge-base', '--is-ancestor', remote, pushed])
    assert.match(trace, /built-in: git push --set-upstream origin /)
    assert.doesNotMatch(trace, /built-in: git (?:push .*--force|rebase)/)
    assert.equal(f.writers(), 1)
  })
}

test('conflicting outside commits name each commit and author, abort the merge and leave the branch clean', async (t) => {
  const f = await fixture(t)
  const outside = await f.outside()
  const first = await f.commit(
    outside,
    'README.md',
    'outside version',
    'First Author',
  )
  const second = await f.commit(
    outside,
    'outside.txt',
    'extra work',
    'Second Author',
  )
  await f.git(outside, ['push', 'origin', f.ticket.branch])
  const local = await f.commit(f.cwd, 'README.md', 'local version')
  const trace = await f.publish()
  const detail = await f.detail()
  const attempt = detail.attempts.at(-2)!
  assert.equal(attempt.outcome, 'needs-decision')
  assert.equal(detail.ticket.status, 'needs-you')
  for (const [commit, subject, author] of [
    [first, 'outside version', 'First Author'],
    [second, 'extra work', 'Second Author'],
  ]) {
    assert.ok(attempt.summary!.includes(commit!.slice(0, 7)))
    assert.ok(attempt.summary!.includes(subject!))
    assert.ok(attempt.summary!.includes(author!))
  }
  assert.match(attempt.summary!, /README.md/)
  assert.match(
    detail.artifacts.find((a) => a.kind === 'finding')!.content!,
    /README.md/,
  )
  assert.equal(await f.git(f.cwd, ['status', '--porcelain']), '')
  assert.equal(await f.git(f.cwd, ['rev-parse', 'HEAD']), local)
  await assert.rejects(f.git(f.cwd, ['rev-parse', '--verify', 'MERGE_HEAD']))
  assert.equal(await f.git(f.bare, ['rev-parse', f.ticket.branch]), second)
  assert.equal(f.writers(), 0)
  assert.equal(f.ghCalls.length, 0)
  assert.doesNotMatch(trace, /built-in: git push /)
})

test('outside commit invalidates a reviewer verdict when the workflow has no tester', async (t) => {
  const f = await fixture(t, 'reviewer')
  const outside = await f.outside()
  await f.commit(outside, 'outside.txt', 'human work')
  await f.git(outside, ['push', 'origin', f.ticket.branch])
  await f.publish()
  const detail = await f.detail()
  assert.equal(detail.attempts.at(-2)!.outcome, 'base-moved')
  assert.match(detail.attempts.at(-2)!.summary!, /review again/)
  assert.equal(detail.ticket.currentStep, 'verify')
  assert.equal(f.writers(), 0)
})

for (const state of ['CLOSED', 'MERGED'] as const) {
  test(`publication creates a new PR when only a ${state} branch PR exists`, async (t) => {
    const f = await fixture(t, 'tester', state)
    await f.publish()
    const detail = await f.detail()
    assert.equal(detail.attempts.at(-2)!.outcome, 'ready')
    assert.equal(
      detail.ticket.pullRequestUrl,
      'https://github.com/fixture/repo/pull/2',
    )
    assert.deepEqual(
      f.ghCalls.map((args) => args[1]),
      ['list', 'create'],
    )
    assert.equal(await f.git(f.bare, ['rev-parse', f.ticket.branch]), f.head)
  })
}

for (const remote of ['same', 'behind', 'deleted'] as const) {
  test(`remote ticket branch ${remote}: current verdict publishes unchanged`, async (t) => {
    const f = await fixture(t)
    await f.git(f.cwd, ['push', 'origin', f.ticket.branch])
    if (remote === 'behind') {
      const base = await f.git(f.cwd, ['rev-parse', 'HEAD^'])
      await f.git(f.bare, ['update-ref', `refs/heads/${f.ticket.branch}`, base])
    } else if (remote === 'deleted') {
      await f.git(f.bare, ['update-ref', '-d', `refs/heads/${f.ticket.branch}`])
    }
    await f.publish()
    assert.equal(await f.git(f.cwd, ['rev-parse', 'HEAD']), f.head)
    assert.equal((await f.detail()).attempts.at(-2)!.outcome, 'ready')
    assert.deepEqual(
      f.ghCalls.map((args) => args[1]),
      ['list', 'edit'],
    )
    assert.equal(f.writers(), 1)
  })
}
