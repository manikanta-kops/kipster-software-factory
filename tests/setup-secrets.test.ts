import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { readConfig } from '../src/config.ts'
import { createTestDatabase } from './helpers/database.ts'
import { openDatabase } from '../src/store/database.ts'
import { secretStore } from '../src/secrets/store.ts'
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
function command(
  args: string[],
  input = '',
  toolPath?: string,
): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, [cli, ...args], {
    stdio: 'pipe',
    ...(toolPath ? { env: { ...process.env, PATH: toolPath } } : {}),
  })
  let output = ''
  child.stdout.on('data', (data) => {
    output += data
  })
  child.stderr.on('data', (data) => {
    output += data
  })
  child.stdin.end(input)
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, output }))
  })
}
test('CLI secret set, list, update and remove stay on the file backend and never show values', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'ksf-secrets-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const args = ['--home', home, '--secret-backend', 'file']
  const sentinel = 'hidden-value-for-automated-tests'
  const set = await command(
    ['secret', 'set', 'example', ...args],
    `${sentinel}\n`,
  )
  assert.equal(set.code, 0)
  assert.equal(set.output.includes(sentinel), false)
  assert.equal((await stat(join(home, 'secrets.json'))).mode & 0o777, 0o600)
  assert.equal(await secretStore(home, 'file').get('example'), sentinel)
  const listed = await command(['secret', 'list', ...args])
  assert.match(listed.output, /example\s+file/)
  assert.equal(listed.output.includes(sentinel), false)
  assert.equal(
    (await command(['secret', 'set', 'example', ...args], 'replacement\n'))
      .code,
    0,
  )
  assert.equal(await secretStore(home, 'file').get('example'), 'replacement')
  assert.equal(
    (await command(['secret', 'remove', 'example', ...args])).code,
    0,
  )
  assert.equal(await secretStore(home, 'file').get('example'), null)
  assert.equal(
    (await command(['secret', 'set', '../bad', ...args], sentinel)).code,
    1,
  )
  assert.equal((await command(['secret', 'set', 'empty', ...args])).code, 1)
})
test('non-interactive setup migrates real PostgreSQL and preserves fields on re-run', async (t) => {
  const testDatabase = await createTestDatabase()
  const store = {
    url: testDatabase.url,
    database: openDatabase(testDatabase.url),
  }
  t.after(async () => {
    await store.database.end()
    await testDatabase.drop()
  })
  const home = await mkdtemp(join(tmpdir(), 'ksf-setup-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({
      databaseUrl: store.url,
      port: 4701,
      concurrency: 4,
      agents: { default: { cli: 'claude' } },
      futureSetting: { retain: true },
    }),
  )
  const toolPath = join(home, 'test-tools')
  await mkdir(toolPath)
  for (const tool of ['git', 'gh', 'codex', 'claude'])
    await writeFile(join(toolPath, tool), '#!/bin/sh\nexit 1\n', {
      mode: 0o700,
    })
  const first = await command(
    [
      'setup',
      '--home',
      home,
      '--database-url',
      store.url,
      '--port',
      '4702',
      '--non-interactive',
      '--skip-typesafe',
      '--secret-backend',
      'file',
    ],
    '',
    toolPath,
  )
  assert.equal(first.code, 0, first.output)
  for (const tool of ['git', 'gh', 'codex', 'claude'])
    assert.match(first.output, new RegExp(`Warning: ${tool}.*will not work`))
  const migrations = await store.database.query(
    'SELECT version FROM schema_migrations',
  )
  assert.ok(migrations.rows.length >= 6)
  const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'))
  assert.equal(config.port, 4702)
  assert.equal(config.concurrency, 4)
  assert.deepEqual(config.futureSetting, { retain: true })
  assert.equal(config.agents.default.cli, 'claude')
  assert.equal((await readConfig(home)).port, 4702)
  const second = await command(
    [
      'setup',
      '--home',
      home,
      '--non-interactive',
      '--skip-typesafe',
      '--secret-backend',
      'file',
    ],
    '',
    toolPath,
  )
  assert.equal(second.code, 0, second.output)
  assert.deepEqual(
    JSON.parse(await readFile(join(home, 'config.json'), 'utf8')),
    config,
  )
  const missing = await mkdtemp(join(tmpdir(), 'ksf-unconfigured-'))
  t.after(() => rm(missing, { recursive: true, force: true }))
  await assert.rejects(readConfig(missing), /kf setup/)
  const bad = await command([
    'setup',
    '--home',
    home,
    '--non-interactive',
    '--port',
    '65536',
  ])
  assert.equal(bad.code, 1)
  assert.deepEqual(
    JSON.parse(await readFile(join(home, 'config.json'), 'utf8')),
    config,
  )
})
