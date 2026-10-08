import assert from 'node:assert/strict'
import { test } from 'node:test'
import { replacements } from '../src/domain/tasks.ts'
import type { TaskStatus } from '../src/domain/records.ts'

const task = (
  key: string,
  status: TaskStatus,
  minute: number,
  child: number | null,
) => ({
  key,
  status,
  createdAt: new Date(Date.UTC(2026, 9, 6, 0, minute)).toISOString(),
  child: child === null ? null : { number: child },
})

test('a chain of retries points each ended task at the task that retried it', () => {
  assert.deepEqual(
    replacements([
      task('export', 'cancelled', 0, 10),
      task('export-2', 'failed', 1, 11),
      task('export-3', 'merged', 2, 12),
    ]),
    new Map([
      ['export', 11],
      ['export-2', 12],
    ]),
  )
})

test('a task with no later task of its stem is not replaced', () => {
  assert.deepEqual(
    replacements([
      task('export', 'merged', 0, 10),
      task('api', 'failed', 1, 11),
      task('docs', 'conflict', 2, 12),
    ]),
    new Map(),
  )
})

test('a successor without a child ticket does not replace yet', () => {
  assert.deepEqual(
    replacements([
      task('export', 'cancelled', 0, 10),
      task('export-2', 'pending', 1, null),
      task('export-3', 'pending', 2, 12),
    ]),
    new Map(),
  )
})

test('unrelated keys, earlier tasks and same-batch tasks never replace', () => {
  assert.deepEqual(
    replacements([
      task('report-2', 'pending', 0, 9),
      task('report', 'failed', 1, 10),
      task('reports', 'merged', 2, 11),
      task('report-export', 'merged', 3, 12),
      task('api', 'failed', 4, 13),
      task('api-2', 'merged', 4, 14),
    ]),
    new Map(),
  )
})

test('only tasks that ended without landing are replaced', () => {
  assert.deepEqual(
    replacements([
      task('export', 'merged', 0, 10),
      task('export-2', 'left-open', 1, 11),
      task('export-3', 'conflict', 2, 12),
      task('export-4', 'running', 3, 13),
    ]),
    new Map([['export-3', 13]]),
  )
})
