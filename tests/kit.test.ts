import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  loadKit,
  loadTrustedInstructions,
  parseKit,
  validateFeatureMap,
} from '../src/kit/kit.ts'
import {
  CONTEXT_INDEX_LIMIT,
  contextIndexSection,
} from '../src/engine/prompt.ts'
import { Workspaces } from '../src/workspace/workspaces.ts'
import {
  createRepository,
  getRepository,
  markRepositoryReady,
} from '../src/store/repositories.ts'
import { createTestStore } from './helpers/store.ts'

export const featureMap = `# Feature
## Sub-features
- Health
## How to get to it (user point of view)
Open health
## Driving it
| User action | Exact command | Observable result |
| --- | --- | --- |
| Open health | curl "$APP_URL/health" | 200 OK |
## Gotchas
None.
`
export const kitYaml = `version: 1
setup: echo setup
check: echo check
verify:
  start: node app.ts {port} {databaseUrl}
  ready: http://127.0.0.1:{port}/health
  ports: 1
  database: postgres
  timeoutSeconds: 5
`
test('kit strict validation and feature-map contract', () => {
  assert.equal(parseKit(kitYaml).verify?.database, 'postgres')
  assert.equal(parseKit('version: 1\ncheck: true-command').setup, undefined)
  for (const source of [
    kitYaml.replace('version: 1', 'version: 2'),
    kitYaml.replace('ports: 1', 'ports: 0'),
    kitYaml.replace('postgres', 'sqlite'),
    kitYaml.replace('{databaseUrl}', ''),
    kitYaml.replaceAll('{port}', '{port2}'),
    kitYaml.replace('127.0.0.1', 'example.com'),
    kitYaml.replace(
      'http://127.0.0.1:{port}/health',
      'http://127.0.0.1:1234/health?port={port}',
    ),
    `${kitYaml}\nunknown: yes`,
    kitYaml.replace('timeoutSeconds: 5', 'timeoutSeconds: 0'),
  ])
    assert.throws(() => parseKit(source))
  validateFeatureMap(featureMap)
  for (const source of [
    featureMap + '\n## Extra\nno',
    featureMap.replace('## Gotchas', '## Notes'),
    featureMap.replace('curl "$APP_URL/health"', ''),
    featureMap.replace('Exact command', 'Hints'),
  ])
    assert.throws(() => validateFeatureMap(source))
})

test('fetch refreshes capabilities from default-branch committed kit, including invalid and missing changes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kit-test-'))
  const source = join(root, 'source')
  await mkdir(source)
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: source,
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim()
  git(['init', '-b', 'next'])
  const commit = () => {
    git(['add', '-A'])
    git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--allow-empty',
      '-m',
      'Fixture',
    ])
  }
  commit()
  const store = await createTestStore()
  t.after(async () => {
    await store.close()
    await rm(root, { recursive: true, force: true })
  })
  const repository = await createRepository(store.database, {
    slug: 'kit/fixture',
    cloneUrl: source,
  })
  const workspaces = new Workspaces(
    join(root, 'home'),
    (repo, defaultBranch, kit) =>
      markRepositoryReady(store.database, repo.id, { defaultBranch, kit }),
  )
  const refresh = async () => {
    await workspaces.prepareRepository(repository, new AbortController().signal)
    return (await getRepository(store.database, repository.slug))!
  }
  assert.equal((await refresh()).kit.status, 'missing')
  await mkdir(join(source, '.kipster/verify/features'), { recursive: true })
  await writeFile(join(source, '.kipster/kit.yml'), kitYaml)
  await writeFile(
    join(source, '.kipster/verify/README.md'),
    'Drive the provided URL; save evidence.',
  )
  await writeFile(
    join(source, '.kipster/verify/features/health.md'),
    featureMap,
  )
  commit()
  const valid = await refresh()
  assert.equal(valid.defaultBranch, 'next')
  assert.deepEqual(valid.kit, {
    status: 'valid',
    error: null,
    capabilities: ['setup', 'verify'],
  })
  assert.deepEqual(valid.capabilities, valid.kit.capabilities)
  // A dirty cache checkout must not determine capabilities.
  await writeFile(
    join(workspaces.cache(repository), '.kipster'),
    'dirty cache file',
  )
  assert.equal((await refresh()).kit.status, 'valid')
  await writeFile(
    join(source, '.kipster/verify/features/health.md'),
    'Incomplete map',
  )
  commit()
  const invalid = await refresh()
  assert.equal(invalid.kit.status, 'invalid')
  assert.match(invalid.kit.error!, /health.md/)
  assert.deepEqual(invalid.capabilities, [])
  await rm(join(source, '.kipster'), { recursive: true })
  commit()
  assert.equal((await refresh()).kit.status, 'missing')
  assert.equal((await loadKit(source, git(['rev-parse', 'HEAD']))).kit, null)
})

test('optional merge migration globs are additive and validated', () => {
  assert.deepEqual(
    parseKit(
      'version: 1\ncheck: "true"\nmerge:\n  migrations: [changes/*.sql, "**/updates/**"]\n',
    ).merge,
    { migrations: ['changes/*.sql', '**/updates/**'] },
  )
  for (const glob of [
    '/outside/**',
    '../outside/**',
    '!migrations/**',
    '{a,b}/**',
  ])
    assert.throws(() =>
      parseKit(
        `version: 1\ncheck: "true"\nmerge:\n  migrations: ["${glob}"]\n`,
      ),
    )
})

test('trusted instructions come from the committed blob, not the working tree', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'factory-trusted-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore' })
  await writeFile(join(root, 'README.md'), 'fixture\n')
  const commit = () => {
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '-m',
        'Commit',
      ],
      { cwd: root, stdio: 'ignore' },
    )
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
  }
  const bare = commit()
  assert.deepEqual(await loadTrustedInstructions(root, bare, 'builder'), {
    roleInstructions: '',
    contextIndex: '',
  })
  await mkdir(join(root, '.kipster/roles'), { recursive: true })
  await mkdir(join(root, '.kipster/context'))
  await writeFile(join(root, '.kipster/roles/builder.md'), 'Trusted builder.\n')
  await writeFile(join(root, '.kipster/roles/tester.md'), 'Tester only.\n')
  await writeFile(
    join(root, '.kipster/context/index.md'),
    '- [Billing](billing.md): read before touching invoices.\n',
  )
  const trusted = commit()
  await writeFile(join(root, '.kipster/roles/builder.md'), 'Edited builder.\n')
  await writeFile(join(root, '.kipster/context/index.md'), 'Edited index.\n')
  assert.deepEqual(await loadTrustedInstructions(root, trusted, 'builder'), {
    roleInstructions: 'Trusted builder.',
    contextIndex: '- [Billing](billing.md): read before touching invoices.',
  })
  assert.equal(
    (await loadTrustedInstructions(root, trusted, 'reviewer')).roleInstructions,
    '',
  )
  assert.equal(
    (await loadTrustedInstructions(root, bare, 'builder')).contextIndex,
    '',
  )
})

test('a long context index is truncated on a line boundary, never rejected', () => {
  assert.equal(contextIndexSection(''), '')
  assert.equal(contextIndexSection('  \n'), '')
  const short = contextIndexSection('- [Domain](domain.md): vocabulary.')
  assert.match(
    short,
    /^Repository context index \(\.kipster\/context\/index\.md/,
  )
  assert.match(short, /- \[Domain\]\(domain\.md\): vocabulary\.$/)
  assert.doesNotMatch(short, /Truncated/)
  const line = `- [Doc](doc.md): ${'x'.repeat(80)}\n`
  const long = line.repeat(Math.ceil((CONTEXT_INDEX_LIMIT * 2) / line.length))
  const section = contextIndexSection(long)
  const body = section.split('\n\n')[1]!
  assert.ok(body.length <= CONTEXT_INDEX_LIMIT)
  assert.ok(body.split('\n').every((entry) => entry === line.trimEnd()))
  assert.match(
    section,
    new RegExp(
      `\\[Truncated at ${CONTEXT_INDEX_LIMIT} of ${long.length} characters\\. Read \\.kipster/context/index\\.md for the rest\\.\\]$`,
    ),
  )
  const unbroken = contextIndexSection('y'.repeat(CONTEXT_INDEX_LIMIT + 5))
  assert.equal(unbroken.split('\n\n')[1], 'y'.repeat(CONTEXT_INDEX_LIMIT))
})
