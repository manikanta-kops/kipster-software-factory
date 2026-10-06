import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { killProcessGroup } from '../src/executors/process-group.ts'
import { run } from '../src/executors/process.ts'

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
        `alias.hang=!sh -c 'echo $$ > "${pidFile}"; exec sleep 30'`,
        'hang',
      ],
      { cwd: directory, signal: controller.signal },
    )
    const outcome = running.then(
      () => 'resolved',
      (error: Error) => error.name,
    )
    let pid = 0
    for (let tries = 0; !pid && tries < 250; tries++) {
      pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'))
      if (!pid) await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.ok(pid > 0, 'the git alias never started')
    controller.abort()
    let alive = true
    for (let tries = 0; alive && tries < 250; tries++) {
      try {
        process.kill(pid, 0)
        await new Promise((resolve) => setTimeout(resolve, 20))
      } catch {
        alive = false
      }
    }
    assert.equal(alive, false, 'the process git started outlived the abort')
    assert.equal(await outcome, 'AbortError')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
