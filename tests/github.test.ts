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

test('checks use the pushed SHA, paginate, honor required checks and fetch a bounded failed-job log', async () => {
  const calls: (readonly string[])[] = []
  let page = 0
  const head = 'a'.repeat(40)
  const github = createGitHub(async (_command, args) => {
    calls.push(args)
    if (args[0] === 'run')
      return 'x'.repeat(3000) + '\nType mismatch at app.ts:12'
    if (args.includes('--slurp')) return '[[]]'
    assert.ok(args.includes(`sha=${head}`))
    page++
    return JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            headRefOid: head,
            baseRefName: 'main',
            baseRef: {
              branchProtectionRule: { requiredStatusCheckContexts: ['build'] },
            },
          },
          object: {
            statusCheckRollup: {
              contexts: {
                pageInfo: { hasNextPage: page === 1, endCursor: 'next' },
                nodes:
                  page === 1
                    ? [
                        {
                          kind: 'CheckRun',
                          name: 'optional',
                          isRequired: false,
                          status: 'COMPLETED',
                          conclusion: 'FAILURE',
                        },
                      ]
                    : [
                        {
                          kind: 'CheckRun',
                          name: 'build',
                          isRequired: true,
                          status: 'COMPLETED',
                          conclusion: 'FAILURE',
                          databaseId: 123,
                          detailsUrl:
                            'https://github.com/acme/repo/actions/runs/42/job/123',
                        },
                      ],
              },
            },
          },
        },
      },
    })
  })
  const checks = await github.checks(
    'acme/repo',
    'https://github.com/acme/repo/pull/1',
    head,
    new AbortController().signal,
  )
  assert.equal(checks.state, 'failed')
  assert.deepEqual(
    checks.failures.map((f) => f.name),
    ['optional', 'build'],
  )
  assert.equal(
    checks.failures[0]!.excerpt,
    'No log excerpt supplied by this check provider.',
  )
  assert.equal(checks.failures[1]!.excerpt.length, 2000)
  assert.match(checks.failures[1]!.excerpt, /Type mismatch/)
  assert.ok(calls.some((args) => args.includes('cursor=next')))
  assert.ok(
    calls.some((args) => args.includes('--log-failed') && args.includes('123')),
  )
})

for (const state of [
  'pending',
  'passed',
  'none',
  'head-changed',
  'missing-required',
  'ruleset-required',
] as const) {
  test(`GitHub check adapter: ${state}`, async () => {
    const head = 'a'.repeat(40)
    const github = createGitHub(async (_command, args) => {
      if (args.includes('--slurp'))
        return state === 'ruleset-required'
          ? '[[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"build"}]}}]]'
          : '[[]]'
      return JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              headRefOid: state === 'head-changed' ? 'b'.repeat(40) : head,
              baseRefName: 'main',
              baseRef: {
                branchProtectionRule: {
                  requiredStatusCheckContexts:
                    state === 'missing-required' ? ['build'] : [],
                },
              },
            },
            object: {
              statusCheckRollup: {
                contexts: {
                  pageInfo: { hasNextPage: false },
                  nodes: ['pending', 'passed'].includes(state)
                    ? [
                        {
                          kind: 'StatusContext',
                          context: 'build',
                          isRequired: true,
                          state: state === 'passed' ? 'SUCCESS' : 'PENDING',
                        },
                      ]
                    : [],
                },
              },
            },
          },
        },
      })
    })
    const checks = await github.checks(
      'acme/repo',
      'https://github.com/acme/repo/pull/1',
      head,
      new AbortController().signal,
    )
    assert.equal(
      checks.state,
      ['missing-required', 'ruleset-required'].includes(state)
        ? 'pending'
        : state,
    )
  })
}

for (const optional of ['pending', 'failed', 'cancelled'] as const)
  for (const requiredState of ['SUCCESS', 'PENDING'] as const)
    test(`non-required ${optional} check while required is ${requiredState.toLowerCase()}`, async () => {
      const head = 'a'.repeat(40)
      const github = createGitHub(async (_command, args) => {
        if (args.includes('--slurp')) return '[[]]'
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                headRefOid: head,
                baseRefName: 'main',
                baseRef: {
                  branchProtectionRule: {
                    requiredStatusCheckContexts: ['build'],
                  },
                },
              },
              object: {
                statusCheckRollup: {
                  contexts: {
                    pageInfo: { hasNextPage: false },
                    nodes: [
                      {
                        kind: 'StatusContext',
                        context: 'build',
                        isRequired: true,
                        state: requiredState,
                      },
                      {
                        kind: 'CheckRun',
                        name: 'Bundle',
                        isRequired: false,
                        status:
                          optional === 'pending' ? 'IN_PROGRESS' : 'COMPLETED',
                        conclusion:
                          optional === 'failed'
                            ? 'FAILURE'
                            : optional === 'cancelled'
                              ? 'CANCELLED'
                              : null,
                        detailsUrl: 'https://ci.example/bundle',
                        summary: 'Bundle exceeds 500 kB',
                      },
                    ],
                  },
                },
              },
            },
          },
        })
      })
      const checks = await github.checks(
        'acme/repo',
        'https://github.com/acme/repo/pull/1',
        head,
        new AbortController().signal,
      )
      if (optional === 'pending') {
        // Never wait on a non-required check.
        assert.equal(
          checks.state,
          requiredState === 'SUCCESS' ? 'passed' : 'pending',
        )
        assert.deepEqual(checks.failures, [])
      } else {
        assert.equal(checks.state, 'failed')
        assert.deepEqual(checks.failures, [
          {
            name: 'Bundle',
            url: 'https://ci.example/bundle',
            excerpt: 'Bundle exceeds 500 kB',
          },
        ])
      }
      assert.deepEqual(
        checks.checks?.find((c) => c.name === 'Bundle'),
        {
          name: 'Bundle',
          required: false,
          url: 'https://ci.example/bundle',
          state: optional === 'pending' ? 'pending' : 'failed',
        },
      )
    })

test('feedback includes change requests, owner and inline comments; ignores factory, bots, outsiders and superseded reviews', async () => {
  const make = (id: number, login: string, body: string, extra = {}) => ({
    id,
    user: { login, type: 'User' },
    body,
    html_url: `https://github.com/comment/${id}`,
    created_at: '2026-10-04T10:00:00Z',
    submitted_at: '2026-10-04T10:00:00Z',
    ...extra,
  })
  const github = createGitHub(async (_command, args) => {
    if (args.includes('user')) return 'operator'
    assert.ok(args.includes('--paginate'))
    const path = args.at(-1)!
    if (path.endsWith('/reviews'))
      return JSON.stringify([
        [
          make(1, 'reviewer', 'Fix this', { state: 'CHANGES_REQUESTED' }),
          make(2, 'superseded', 'Old request', { state: 'CHANGES_REQUESTED' }),
        ],
        [
          make(3, 'superseded', 'Approved now', { state: 'APPROVED' }),
          make(4, 'acme', 'Owner review note', { state: 'COMMENTED' }),
        ],
      ])
    if (path.includes('/issues/'))
      return JSON.stringify([
        [
          make(5, 'acme', 'Owner note'),
          make(6, 'operator', 'Operator note'),
          make(7, 'acme', 'Generated <!-- kipster-factory -->'),
          make(8, 'someone', 'Unrelated'),
          make(9, 'acme', 'Bot', { user: { login: 'acme', type: 'Bot' } }),
        ],
      ])
    return JSON.stringify([
      [make(10, 'acme', 'Inline correction', { path: 'app.ts', line: 12 })],
    ])
  })
  const feedback = await github.feedback(
    'acme/repo',
    'https://github.com/acme/repo/pull/1',
    new AbortController().signal,
  )
  assert.deepEqual(
    feedback.map((f) => f.id),
    ['review:1', 'review:4', 'comment:5', 'comment:6', 'inline:10'],
  )
  assert.match(feedback.at(-1)!.body, /app.ts:12/)
})

test('PR fact adapter compares the head against today’s base tip, including merged PRs', async () => {
  const github = createGitHub(async (_command, args) => {
    if (args[1] === 'view')
      return JSON.stringify({
        url: 'https://github.com/acme/shop/pull/1',
        state: 'MERGED',
        headRefOid: 'a'.repeat(40),
        baseRefOid: 'b'.repeat(40),
        baseRefName: 'next',
        isDraft: false,
        mergeable: 'UNKNOWN',
      })
    if (args.includes('--jq')) return 'c'.repeat(40)
    assert.ok(
      args.some((a) => a.includes(`${'a'.repeat(40)}...${'c'.repeat(40)}`)),
    )
    return JSON.stringify({ ahead_by: 4 })
  })
  const pr = await github.inspect(
    'acme/shop',
    'https://github.com/acme/shop/pull/1',
    new AbortController().signal,
  )
  assert.equal(pr.baseRefOid, 'c'.repeat(40))
  assert.equal(pr.behind, 4)
  assert.equal(pr.mergeable, 'UNKNOWN')
})

test('factory merge is squash and atomically matches the decided head', async () => {
  const head = 'a'.repeat(40)
  const github = createGitHub(async (command, args) => {
    assert.equal(command, 'gh')
    assert.deepEqual(args, [
      'pr',
      'merge',
      'https://github.com/acme/shop/pull/3',
      '--repo',
      'acme/shop',
      '--squash',
      '--match-head-commit',
      head,
    ])
    return ''
  })
  await github.merge(
    'acme/shop',
    'https://github.com/acme/shop/pull/3',
    head,
    new AbortController().signal,
  )
})
test('post-merge check queries the merge commit without a PR-head guard and paginates all reported checks', async () => {
  const head = 'b'.repeat(40)
  let page = 0
  const github = createGitHub(async (_command, args) => {
    if (args.includes('graphql')) {
      page++
      const query = args.find((arg) => arg.startsWith('query='))!
      assert.equal(query.includes('$number'), false)
      assert.equal(query.includes('pullRequest('), false)
      assert.ok(args.includes(`sha=${head}`))
      return JSON.stringify({
        data: {
          repository: {
            object: {
              statusCheckRollup: {
                contexts: {
                  nodes: [
                    {
                      kind: 'CheckRun',
                      name: page === 1 ? 'Required CI' : 'Other CI',
                      status: 'COMPLETED',
                      conclusion: 'SUCCESS',
                    },
                  ],
                  pageInfo: { hasNextPage: page === 1, endCursor: 'next' },
                },
              },
            },
          },
        },
      })
    }
    return JSON.stringify([
      [
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: [{ context: 'Required CI' }] },
        },
      ],
    ])
  })
  const checks = await github.commitChecks(
    'acme/shop',
    'next',
    head,
    new AbortController().signal,
  )
  assert.equal(page, 2)
  assert.equal(checks.state, 'passed')
  assert.equal(
    checks.checks!.find((c) => c.name === 'Required CI')!.required,
    false,
  )
})

test('post-merge with no reported checks ignores PR-only required contexts', async () => {
  let ruleRequests = 0
  const github = createGitHub(async (_command, args) => {
    if (!args.includes('graphql')) {
      ruleRequests++
      return JSON.stringify([
        [
          {
            type: 'required_status_checks',
            parameters: { required_status_checks: [{ context: 'PR-only CI' }] },
          },
        ],
      ])
    }
    return JSON.stringify({
      data: { repository: { object: { statusCheckRollup: null } } },
    })
  })
  const checks = await github.commitChecks(
    'acme/shop',
    'next',
    'b'.repeat(40),
    new AbortController().signal,
  )
  assert.equal(checks.state, 'none')
  assert.deepEqual(checks.checks, [])
  assert.equal(ruleRequests, 0)
})

test('post-merge watches optional failures as well as required checks', async () => {
  const github = createGitHub(async (_command, args) =>
    args.includes('graphql')
      ? JSON.stringify({
          data: {
            repository: {
              object: {
                statusCheckRollup: {
                  contexts: {
                    nodes: [
                      {
                        kind: 'CheckRun',
                        name: 'Required',
                        status: 'COMPLETED',
                        conclusion: 'SUCCESS',
                      },
                      {
                        kind: 'CheckRun',
                        name: 'Regression',
                        status: 'COMPLETED',
                        conclusion: 'FAILURE',
                        text: 'Broken after merge',
                      },
                    ],
                    pageInfo: { hasNextPage: false },
                  },
                },
              },
            },
          },
        })
      : JSON.stringify([
          [
            {
              type: 'required_status_checks',
              parameters: { required_status_checks: [{ context: 'Required' }] },
            },
          ],
        ]),
  )
  const checks = await github.commitChecks(
    'acme/shop',
    'next',
    'a'.repeat(40),
    new AbortController().signal,
  )
  assert.equal(checks.state, 'failed')
  assert.equal(checks.failures[0]!.name, 'Regression')
})
