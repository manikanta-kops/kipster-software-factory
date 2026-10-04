import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGitHub } from '../src/github/github.ts'

test('GitHub adapter reuses a branch PR and passes exact Markdown through stdin', async () => {
  const calls: { args: readonly string[]; input: string | undefined }[] = []
  let created = false
  const github = createGitHub(async (command, args, options) => {
    assert.equal(command, 'gh')
    calls.push({ args, input: options?.input })
    if (args[1] === 'list')
      return JSON.stringify(
        created
          ? [
              {
                url: 'https://github.com/acme/shop/pull/1',
                state: 'OPEN',
                headRepositoryOwner: { login: 'acme' },
              },
            ]
          : [],
      )
    if (args[1] === 'create') {
      created = true
      return 'https://github.com/acme/shop/pull/1'
    }
    return ''
  })
  const input = {
    repository: 'acme/shop',
    branch: 'kipster/1-test',
    base: 'main',
    title: 'Literal $() and `title`',
    body: 'Plan\n\nKeep `code` and $(literal) intact.',
    cwd: '/tmp',
    signal: new AbortController().signal,
  }
  const first = await github.maintain(input)
  const second = await github.maintain(input)
  assert.equal(first.url, second.url)
  assert.equal(calls.filter((call) => call.args[1] === 'create').length, 1)
  const edits = calls.filter((call) => call.args[1] === 'edit')
  assert.equal(edits.length, 1)
  assert.equal(edits[0]!.input, input.body)
  assert.ok(edits[0]!.args.includes('--body-file'))
})

test('GitHub adapter reuses merged and closed PRs so merge polling resolves them', async () => {
  for (const state of ['MERGED', 'CLOSED'] as const) {
    const github = createGitHub(async (_command, args) => {
      assert.equal(args[1], 'list')
      return JSON.stringify([
        {
          url: 'https://github.com/acme/shop/pull/1',
          state,
          headRepositoryOwner: { login: 'acme' },
        },
      ])
    })
    const pr = await github.maintain({
      repository: 'acme/shop',
      branch: 'kipster/1-test',
      base: 'main',
      title: 'Title',
      body: 'Body',
      cwd: '/tmp',
      signal: new AbortController().signal,
    })
    assert.equal(pr.state, state)
  }
})
