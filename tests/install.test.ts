import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { defaultHome } from '../src/config.ts'
import {
  launchAgent,
  serviceLabel,
  servicePath,
  waitForFactory,
} from '../src/service.ts'
import { freePort } from '../src/setup.ts'
import {
  isClusterRunning,
  managedCluster,
  stopCluster,
} from '../src/store/cluster.ts'

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

test('the launch agent runs the factory with the captured PATH and escapes values', () => {
  const plist = launchAgent({
    label: 'app.kipster.factory',
    program: ['/opt/kf/node', '/opt/kf/app/src/cli.ts', 'serve'],
    path: '/opt/homebrew/bin:/Users/a&b/.local/bin',
    log: '/Users/me/.kipster-factory/logs/factory.log',
    workingDirectory: '/Users/me/.kipster-factory',
  })
  assert.match(
    plist,
    /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/opt\/kf\/node<\/string>\s*<string>\/opt\/kf\/app\/src\/cli.ts<\/string>\s*<string>serve<\/string>/,
  )
  assert.match(
    plist,
    /<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:\/Users\/a&amp;b\/.local\/bin<\/string>/,
  )
  assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/)
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/)
  assert.equal(
    servicePath('/repo/node_modules/.bin:/opt/homebrew/bin::/usr/bin'),
    '/opt/homebrew/bin:/usr/bin',
  )
  assert.equal(serviceLabel(defaultHome()), 'app.kipster.factory')
  assert.match(
    serviceLabel('/tmp/other'),
    /^app\.kipster\.factory\.[0-9a-f]{8}$/,
  )
})

test('setup picks the next free port when the default is taken', async (t) => {
  const busy = createServer()
  await new Promise<void>((resolve) => busy.listen(0, '127.0.0.1', resolve))
  t.after(() => busy.close())
  const port = (busy.address() as { port: number }).port
  const chosen = await freePort(port)
  assert.ok(chosen > port)
})

test('setup without a database URL creates a private PostgreSQL that serve starts and stops', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'ksf-managed-'))
  const cluster = managedCluster(home)
  t.after(async () => {
    if (isClusterRunning(cluster)) stopCluster(cluster)
    await rm(home, { recursive: true, force: true })
    await rm(cluster.socketDirectory, { recursive: true, force: true })
  })
  const tools = join(home, 'test-tools')
  await mkdir(tools)
  await writeFile(join(tools, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
  await writeFile(join(tools, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
  await writeFile(
    join(tools, 'claude'),
    '#!/bin/sh\necho "2.1.0 (Claude Code)"\n',
    { mode: 0o700 },
  )
  const env = { ...process.env, PATH: `${tools}:${process.env['PATH']}` }
  const port = await freePort(4870)

  const setup = await command(
    [
      'setup',
      '--home',
      home,
      '--non-interactive',
      '--port',
      String(port),
      '--secret-backend',
      'file',
    ],
    env,
  )
  assert.equal(setup.code, 0, setup.output)
  assert.match(setup.output, /Claude\s+2\.1\.0/)
  assert.match(setup.output, /Database\s+private PostgreSQL in .*postgres/)
  assert.equal(setup.output.includes('\u001b[?25l'), false)
  const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'))
  assert.equal(config.databaseUrl, undefined)
  assert.equal(config.port, port)
  assert.deepEqual(config.agents, { default: { cli: 'claude' }, roles: {} })
  assert.ok(existsSync(join(home, 'postgres', 'PG_VERSION')))
  assert.equal(isClusterRunning(cluster), false)

  const serve = spawn(
    process.execPath,
    [cli, 'serve', '--home', home, '--no-scheduler'],
    { env, stdio: 'pipe' },
  )
  let output = ''
  serve.stdout.on('data', (data) => (output += data))
  serve.stderr.on('data', (data) => (output += data))
  const exited = new Promise<number | null>((resolve) =>
    serve.once('exit', resolve),
  )
  t.after(() => serve.kill('SIGKILL'))
  assert.ok(await waitForFactory(port, 60_000), output)
  assert.equal(isClusterRunning(cluster), true)
  serve.kill('SIGTERM')
  assert.equal(await exited, 0, output)
  assert.equal(isClusterRunning(cluster), false)

  const again = await command(
    ['setup', '--home', home, '--non-interactive', '--secret-backend', 'file'],
    env,
  )
  assert.equal(again.code, 0, again.output)
  assert.match(again.output, /up to date/)
  assert.deepEqual(
    JSON.parse(await readFile(join(home, 'config.json'), 'utf8')),
    config,
  )
})

function command(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, [cli, ...args], { env, stdio: 'pipe' })
  let output = ''
  child.stdout.on('data', (data) => (output += data))
  child.stderr.on('data', (data) => (output += data))
  child.stdin.end()
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, output }))
  })
}
