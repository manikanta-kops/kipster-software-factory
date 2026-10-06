import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { killProcessGroup } from '../src/executors/process-group.ts'

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
