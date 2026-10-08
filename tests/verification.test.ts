import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { openDatabase } from '../src/store/database.ts'
import {
  startVerification,
  VerificationError,
  verificationFinding,
} from '../src/verification/harness.ts'
import type { Kit } from '../src/kit/kit.ts'
import { createTestStore } from './helpers/store.ts'
import { until, controlledTimeout } from './helpers/timing.ts'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'verification-test-'))
  const repository = join(root, 'source')
  await mkdir(repository)
  await copyFile(
    new URL('./fixtures/verification-app.ts', import.meta.url),
    join(repository, 'app.ts'),
  )
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: repository,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  git(['init', '-b', 'main'])
  git(['add', '.'])
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    'Fixture',
  ])
  const commit = git(['rev-parse', 'HEAD'])
  await writeFile(
    join(repository, 'uncommitted'),
    'must not appear in instance',
  )
  const store = await createTestStore()
  t.after(async () => {
    await store.close()
    await rm(root, { recursive: true, force: true })
  })
  const kit: Kit = {
    version: 1,
    setup: 'echo setup-ran > setup.txt',
    check: 'test -f setup.txt && echo checked',
    verify: {
      start: `${process.execPath} app.ts {port} {databaseUrl} child`,
      ready: 'http://127.0.0.1:{port}/health',
      ports: 2,
      database: 'postgres',
      timeoutSeconds: 60,
    },
  }
  return {
    root,
    repository,
    commit,
    kit,
    database: store.database,
    home: join(root, 'home'),
  }
}

test('verification retains fetched comparison bases without remotes, including when the cache branch is stale', async (t) => {
  const f = await fixture(t)
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: f.repository,
      encoding: 'utf8',
    }).trim()
  git(['update-ref', 'refs/remotes/origin/next', f.commit])
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/next'])
  await writeFile(join(f.repository, 'base.txt'), 'fetched base')
  git(['add', 'base.txt'])
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    'Base advanced',
  ])
  const base = git(['rev-parse', 'HEAD'])
  git(['update-ref', 'refs/remotes/origin/next', base])
  git(['reset', '--hard', f.commit])
  const instance = await startVerification({
    ...f,
    check: true,
    checkOnly: true,
    kit: {
      version: 1,
      setup: `test "$(git rev-parse origin/next)" = ${base}`,
      check:
        'test "$(git show origin/next:base.txt)" = "fetched base" && test -z "$(git remote)" && test ! -f base.txt',
    },
  })
  t.after(() => instance.stop())
  assert.equal(
    execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: instance.checkout,
      encoding: 'utf8',
    }).trim(),
    f.commit,
  )
  assert.throws(() =>
    execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: instance.checkout,
      stdio: 'pipe',
    }),
  )
})

test('harness runs exact detached commit, setup/check, isolated ports/database and retains logs after idempotent stop', async (t) => {
  const f = await fixture(t)
  const unrelated = spawn(process.execPath, [
    '-e',
    'setInterval(() => {}, 1000)',
  ])
  const unrelatedExit = once(unrelated, 'exit')
  t.after(async () => {
    unrelated.kill()
    await unrelatedExit
  })
  const instance = await startVerification({ ...f, check: true })
  t.after(() => instance.stop())
  assert.equal(
    execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: instance.checkout,
      encoding: 'utf8',
    }).trim(),
    f.commit,
  )
  assert.equal(
    execFileSync('git', ['branch', '--show-current'], {
      cwd: instance.checkout,
      encoding: 'utf8',
    }).trim(),
    '',
  )
  await assert.rejects(access(join(instance.checkout, 'uncommitted')))
  assert.equal(
    await readFile(join(instance.checkout, 'setup.txt'), 'utf8'),
    'setup-ran\n',
  )
  assert.equal(new Set(instance.ports).size, 2)
  const body = (await (await fetch(instance.url)).json()) as {
    databaseUrl: string
    pid: number
  }
  assert.equal(body.databaseUrl, instance.databaseUrl)
  const isolated = openDatabase(instance.databaseUrl!)
  await isolated.query('CREATE TABLE isolation_test (id integer)')
  await isolated.end()
  const name = new URL(instance.databaseUrl!).pathname.slice(1)
  assert.equal(
    (
      await f.database.query('SELECT 1 FROM pg_database WHERE datname=$1', [
        name,
      ])
    ).rowCount,
    1,
  )
  const childPid = Number(
    await readFile(join(instance.checkout, 'child.pid'), 'utf8'),
  )
  await Promise.all([instance.stop(), instance.stop()])
  assert.throws(() => process.kill(body.pid, 0))
  assert.throws(() => process.kill(childPid, 0))
  process.kill(unrelated.pid!, 0)
  assert.equal(
    (
      await f.database.query('SELECT 1 FROM pg_database WHERE datname=$1', [
        name,
      ])
    ).rowCount,
    0,
  )
  await assert.rejects(access(instance.checkout))
  await access(join(f.repository, 'app.ts'))
  assert.equal(instance.logs.length, 3)
  assert.match(
    await readFile(join(instance.evidenceDir, 'check.log'), 'utf8'),
    /checked/,
  )
  assert.match(
    await readFile(join(instance.evidenceDir, 'start.log'), 'utf8'),
    /fixture start/,
  )
})

for (const [mode, expected] of [
  ['timeout', 'ready'],
  ['crash', 'start'],
] as const) {
  test(`harness ${mode} names the stage and cleans checkout/database`, async (t) => {
    const f = await fixture(t)
    f.kit.verify!.start = `${process.execPath} app.ts {port} {databaseUrl} ${mode}`
    const deadline =
      mode === 'timeout' ? controlledTimeout(t, 60_000) : undefined
    let failure: VerificationError | undefined
    const starting = startVerification(f)
    const failed = assert.rejects(starting, (error: unknown) => {
      assert.ok(error instanceof VerificationError)
      failure = error
      return true
    })
    if (deadline) {
      await until(async () => {
        const entries = await readdir(join(f.home, 'verification')).catch(
          () => [],
        )
        const logs = await Promise.all(
          entries
            .filter((name) => name.startsWith('evidence-'))
            .map((name) =>
              readFile(
                join(f.home, 'verification', name, 'start.log'),
                'utf8',
              ).catch(() => ''),
            ),
        )
        return logs.some((log) => log.includes('fixture not ready'))
      }, Boolean)
      deadline.expire()
    }
    await failed
    assert.ok(failure)
    assert.equal(failure.stage, expected)
    assert.match((await verificationFinding(failure)).content!, /fixture/)
    assert.ok(
      (await readdir(join(f.home, 'verification'))).every((name) =>
        name.startsWith('evidence-'),
      ),
    )
    const log = await readFile(join(failure.evidenceDir, 'start.log'), 'utf8')
    assert.match(log, /fixture start/)
  })
}
for (const stage of ['setup', 'check'] as const) {
  test(`harness ${stage} failure retains log and removes checkout`, async (t) => {
    const f = await fixture(t)
    f.kit[stage] = `echo failed-${stage}; exit 9`
    await assert.rejects(
      startVerification({ ...f, check: true }),
      asyncError(stage),
    )
    assert.ok(
      (await readdir(join(f.home, 'verification'))).every((name) =>
        name.startsWith('evidence-'),
      ),
    )
  })
}
function asyncError(stage: string) {
  return (error: unknown) =>
    error instanceof VerificationError && error.stage === stage
}

test('none database, simultaneous instances, cancellation and post-ready crash', async (t) => {
  const f = await fixture(t)
  f.kit.verify!.database = 'none'
  f.kit.verify!.start = `${process.execPath} app.ts {port} {databaseUrl}`
  const first = await startVerification(f)
  t.after(() => first.stop())
  assert.equal(first.databaseUrl, null)
  const { pid } = (await (await fetch(first.url)).json()) as { pid: number }
  const controller = new AbortController()
  const second = await startVerification({ ...f, signal: controller.signal })
  t.after(() => second.stop())
  assert.ok(first.ports.every((port) => !second.ports.includes(port)))
  controller.abort()
  await second.stop()
  await assert.rejects(access(second.checkout))
  process.kill(pid, 'SIGKILL')
  await assert.rejects(first.exited, /start.*failed/)
})

test('checkout failures name their stage and leave no checkout behind', async (t) => {
  const f = await fixture(t)
  await assert.rejects(
    startVerification({ ...f, commit: '0'.repeat(40) }),
    asyncError('checkout'),
  )
  assert.ok(
    (await readdir(join(f.home, 'verification'))).every((name) =>
      name.startsWith('evidence-'),
    ),
  )
})

test('database provisioning failure names its stage and releases resources', async (t) => {
  const f = await fixture(t)
  // A real PostgreSQL role with CONNECT but without CREATEDB.
  const role = `limited_${Date.now()}`
  await f.database.query(`CREATE ROLE ${role} LOGIN`)
  const { databaseUrl } = await import('../src/store/database.ts')
  const url = new URL(databaseUrl(f.database))
  url.username = role
  const limited = openDatabase(url.href)
  try {
    await assert.rejects(
      startVerification({ ...f, database: limited }),
      (error: unknown) =>
        error instanceof VerificationError &&
        error.stage === 'database' &&
        /permission denied/.test(error.message),
    )
  } finally {
    await limited.end()
    await f.database.query(`DROP ROLE ${role}`)
  }
  assert.ok(
    (await readdir(join(f.home, 'verification'))).every((name) =>
      name.startsWith('evidence-'),
    ),
  )
})
