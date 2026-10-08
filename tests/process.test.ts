import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { killProcessGroup } from '../src/executors/process-group.ts'
import { run } from '../src/executors/process.ts'
import { until } from './helpers/timing.ts'

test('an absent process group is already cleaned up', () => {
  killProcessGroup(2_000_000_000)
})

test('EPERM after group exit does not turn a successful command into a failure', (t) => {
  t.mock.method(process, 'kill', () => {
    throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
  })
  killProcessGroup(2_000_000_000)
})

test('EPERM for a group with live members still fails cleanup', (t) => {
  const group = Number(
    execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], {
      encoding: 'utf8',
    }).trim(),
  )
  assert.ok(group > 0)
  t.mock.method(process, 'kill', () => {
    throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
  })
  assert.throws(() => killProcessGroup(group), /EPERM/)
})

test('aborting a git command stops git and the processes it started', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-process-'))
  try {
    const pidFile = join(directory, 'pid')
    const controller = new AbortController()
    const running = run(
      'git',
      [
        '-c',
        `alias.hang=!sh -c 'echo $$ > "${pidFile}"; exec tail -f /dev/null'`,
        'hang',
      ],
      { cwd: directory, signal: controller.signal },
    )
    const outcome = running.then(
      () => 'resolved',
      (error: Error) => error.name,
    )
    const pid = await waitForPid(pidFile)
    assert.ok(pid > 0, 'the git alias never started')
    controller.abort()
    assert.equal(
      await stopped(pid),
      true,
      'the process git started outlived the abort',
    )
    assert.equal(await outcome, 'AbortError')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

async function waitForPid(file: string) {
  return until(
    async () => Number(await readFile(file, 'utf8').catch(() => '0')),
    (pid) => pid > 0,
  )
}

async function stopped(pid: number) {
  return until(async () => {
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  }, Boolean)
}

// A short writeSync means fd 1 is non-blocking; Codex panics on the EAGAIN that follows.
const largeWrite = `
const fs = require('node:fs')
let written
try {
  written = fs.writeSync(1, Buffer.alloc(1_000_000, 'x'))
} catch (error) {
  written = error.code
}
fs.writeFileSync(process.argv[1], String(written))
`

test('a supervised command can write a megabyte to stdout at once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-process-'))
  try {
    const result = join(directory, 'written')
    const output = await run(process.execPath, ['-e', largeWrite, result])
    assert.equal(await readFile(result, 'utf8'), '1000000')
    assert.equal(output.length, 1_000_000)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a supervised command logs a megabyte written to stdout at once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-process-'))
  try {
    const result = join(directory, 'written')
    const log = join(directory, 'log')
    await run(process.execPath, ['-e', largeWrite, result], { log })
    assert.equal(await readFile(result, 'utf8'), '1000000')
    assert.equal((await readFile(log, 'utf8')).length, 1_000_000)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a background process holding stdout does not delay a supervised command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-process-'))
  try {
    const pidFile = join(directory, 'pid')
    const output = await run(
      'sh',
      ['-c', `tail -f /dev/null & echo $! > "${pidFile}"; echo started`],
      { signal: AbortSignal.timeout(60_000) },
    )
    assert.equal(output, 'started')
    assert.ok(
      await stopped(await waitForPid(pidFile)),
      'background job survived',
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a supervised command reports its exit code', async () => {
  assert.equal(await run('sh', ['-c', 'echo hi']), 'hi')
  await assert.rejects(run('sh', ['-c', 'echo hi; exit 7']), /sh exited 7: hi/)
})

test('aborting a supervised command stops its process group', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-process-'))
  try {
    const pidFile = join(directory, 'pid')
    const controller = new AbortController()
    const outcome = run(
      'sh',
      ['-c', `tail -f /dev/null & echo $! > "${pidFile}"; wait`],
      { signal: controller.signal },
    ).then(
      () => 'resolved',
      (error: Error) => error.name,
    )
    const pid = await waitForPid(pidFile)
    controller.abort()
    assert.equal(await outcome, 'AbortError')
    assert.ok(await stopped(pid), 'a process in the group outlived the abort')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
