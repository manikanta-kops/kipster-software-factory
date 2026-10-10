import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { after, before, test } from 'node:test'
import { buildServiceApp } from '../scripts/native.ts'
import { prepareServiceApp, verifyServiceApp } from '../src/service-app.ts'
import { until } from './helpers/timing.ts'

const macOS = process.platform === 'darwin'
let directory: string, source: string
before(async () => {
  if (!macOS) return
  directory = await mkdtemp(join(tmpdir(), 'kf-native-'))
  source = buildServiceApp({ out: join(directory, 'build') })
})
after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function fixture(script: string) {
  const home = await mkdtemp(join(directory, 'factory home '))
  const cli = join(home, 'cli.mjs')
  await writeFile(cli, script)
  const launcher = await prepareServiceApp({
    home,
    cli,
    node: process.execPath,
    source,
    stop: async () => {},
  })
  return { home, cli, launcher }
}

function launch(launcher: string, home: string) {
  const child = spawn(launcher, ['--home', home], { stdio: 'pipe' })
  let output = ''
  child.stdout.on('data', (data) => {
    output += data
  })
  child.stderr.on('data', (data) => {
    output += data
  })
  const done = new Promise<{ code: number | null; output: string }>(
    (resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => resolve({ code, output }))
    },
  )
  return { child, done }
}

test(
  'the signed native app stays the Node parent and passes the factory home and exit status',
  { skip: !macOS },
  async () => {
    verifyServiceApp(source)
    const { home, launcher } = await fixture(
      `console.log(JSON.stringify({ ppid: process.ppid, args: process.argv.slice(2) })); process.exitCode = 23`,
    )
    const { child, done } = launch(launcher, home)
    const result = await done
    assert.equal(result.code, 23, result.output)
    assert.deepEqual(JSON.parse(result.output), {
      ppid: child.pid,
      args: ['serve', '--home', home],
    })
  },
)

test(
  'a signed app without the automation entitlement is rejected before stopping the installed service',
  { skip: !macOS },
  async () => {
    const { home, cli } = await fixture('process.exitCode = 0')
    const copy = join(directory, 'missing-entitlement.app')
    execFileSync('/usr/bin/ditto', [source, copy])
    const empty = join(directory, 'empty.plist')
    await writeFile(
      empty,
      '<?xml version="1.0"?><plist version="1.0"><dict/></plist>',
    )
    execFileSync(
      '/usr/bin/codesign',
      [
        '--force',
        '--sign',
        '-',
        '--options',
        'runtime',
        '--entitlements',
        empty,
        copy,
      ],
      { stdio: 'pipe' },
    )
    let stopped = false
    await assert.rejects(
      prepareServiceApp({
        home,
        cli,
        node: process.execPath,
        source: copy,
        stop: async () => {
          stopped = true
        },
      }),
      /missing its automation entitlement/,
    )
    assert.equal(stopped, false)
  },
)

test(
  'stopping the native parent lets Node finish shutdown before the launcher exits',
  { skip: !macOS },
  async (t) => {
    const { home, launcher } = await fixture(`
    import { writeFileSync } from 'node:fs'; import { join } from 'node:path';
    const home = process.argv.at(-1);
    process.on('SIGTERM', () => { writeFileSync(join(home, 'stopped'), 'yes'); process.exit(0) });
    writeFileSync(join(home, 'ready'), 'yes'); setInterval(() => {}, 1000);
  `)
    const { child, done } = launch(launcher, home)
    t.after(() => {
      if (child.exitCode === null) child.kill('SIGKILL')
    })
    await until(
      async () => readFile(join(home, 'ready'), 'utf8').catch(() => ''),
      (value) => value === 'yes',
    )
    child.kill('SIGTERM')
    const result = await done
    assert.equal(result.code, 0, result.output)
    assert.equal(await readFile(join(home, 'stopped'), 'utf8'), 'yes')
  },
)

test(
  'a failed stop preserves the installed runtime; a successful update keeps the launcher path',
  { skip: !macOS },
  async () => {
    const { home, cli, launcher } = await fixture('process.exitCode = 17')
    const manifest = join(home, 'service', 'runtime.json')
    const originalManifest = await readFile(manifest, 'utf8')
    await assert.rejects(
      prepareServiceApp({
        home,
        cli: '/missing',
        node: process.execPath,
        source,
        stop: async () => {
          throw new Error('still running')
        },
      }),
      /still running/,
    )
    assert.equal(await readFile(manifest, 'utf8'), originalManifest)
    verifyServiceApp(join(home, 'service', 'Kipster Software Factory.app'))
    const next = join(home, 'next.mjs')
    await writeFile(next, 'process.exitCode = 19')
    const updated = await prepareServiceApp({
      home,
      cli: next,
      node: process.execPath,
      source,
      stop: async () => {},
    })
    assert.equal(updated, launcher)
    assert.equal((await launch(updated, home).done).code, 19)
    assert.notEqual(cli, next)
  },
)

test(
  'the launcher refuses a public manifest or a non-private service directory',
  { skip: !macOS },
  async () => {
    const { home, launcher } = await fixture('console.log("should not run")')
    await chmod(join(home, 'service', 'runtime.json'), 0o644)
    const result = await launch(launcher, home).done
    assert.equal(result.code, 78)
    assert.doesNotMatch(result.output, /should not run/)
    const other = await mkdtemp(join(directory, 'other-'))
    await mkdir(join(other, 'service'), { mode: 0o755 })
    await assert.rejects(
      prepareServiceApp({
        home: other,
        cli: '/missing',
        node: process.execPath,
        source,
        stop: async () => {},
      }),
      /private directory/,
    )
  },
)
