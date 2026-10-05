import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadKit, parseKit, validateFeatureMap } from '../src/kit/kit.ts'
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
