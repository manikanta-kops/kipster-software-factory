import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { parseUsage, readUsage } from '../src/executors/usage.ts'
import {
  compactDuration,
  compactNumber,
  ticketUsage,
  usageTotals,
} from '../src/domain/usage.ts'
import type { LeadTask } from '../src/domain/records.ts'

const fixture = (name: string) =>
  new URL(`./fixtures/usage/${name}`, import.meta.url)
const claude = await readFile(fixture('claude-stream.jsonl'), 'utf8')
const codex = await readFile(fixture('codex-exec.jsonl'), 'utf8')

test('Claude usage is the last result event, with cached input counted as input', () => {
  // input_tokens 38 + cache_creation 185012 + cache_read 2892678; assistant message usage is ignored.
  assert.deepEqual(parseUsage('claude', claude), {
    inputTokens: 3_077_728,
    outputTokens: 10_051,
  })
  const earlier = claude.replace('"output_tokens":10051', '"output_tokens":1')
  assert.deepEqual(parseUsage('claude', `${earlier}${claude}`), {
    inputTokens: 3_077_728,
    outputTokens: 10_051,
  })
})

test('Codex usage sums every completed turn without adding cached input again', () => {
  assert.deepEqual(parseUsage('codex', codex), {
    inputTokens: 2_374_730,
    outputTokens: 12_648,
  })
  assert.deepEqual(parseUsage('codex', `${codex}${codex}`), {
    inputTokens: 4_749_460,
    outputTokens: 25_296,
  })
})

test('output without usage gives null; garbage lines are ignored and never throw', () => {
  assert.equal(parseUsage('claude', ''), null)
  assert.equal(parseUsage('codex', claude), null)
  assert.equal(parseUsage('claude', codex), null)
  const noise = [
    'Error: something went wrong',
    '{"type":"result"',
    '{"type":"result","usage":null}',
    'null',
    '[1,2]',
    '{"type":"turn.completed","usage":{"input_tokens":-5,"output_tokens":"9"}}',
  ].join('\n')
  assert.equal(parseUsage('claude', noise), null)
  assert.equal(parseUsage('codex', noise), null)
  assert.deepEqual(parseUsage('codex', `${noise}\n${codex}\n\u0000garbage`), {
    inputTokens: 2_374_730,
    outputTokens: 12_648,
  })
})

test('a missing log has no usage', async () => {
  assert.equal(await readUsage('claude', '/nonexistent/ksf/usage.log'), null)
  assert.deepEqual(
    await readUsage('codex', new URL(fixture('codex-exec.jsonl')).pathname),
    { inputTokens: 2_374_730, outputTokens: 12_648 },
  )
})

test('compact numbers and durations', () => {
  assert.deepEqual(
    [0, 950, 1000, 35_700, 99_960, 121_400, 999_960, 1_234_567, 2e9].map(
      compactNumber,
    ),
    ['0', '950', '1k', '35.7k', '100k', '121k', '1M', '1.2M', '2B'],
  )
  assert.deepEqual(
    [0, 46_000, 460_000, 3_600_000, 4_320_000, 90_000_000].map(compactDuration),
    ['0s', '46s', '7m 40s', '1h 0m', '1h 12m', '25h 0m'],
  )
})

const run = (
  startedAt: string | null,
  finishedAt: string | null,
  inputTokens: number | null = null,
  outputTokens: number | null = null,
) => ({ startedAt, finishedAt, inputTokens, outputTokens })

test('totals count finished runs only; tokens stay null when none were reported', () => {
  assert.deepEqual(
    usageTotals([
      run('2026-01-01T10:00:00Z', '2026-01-01T10:07:40Z', 1000, 50),
      run('2026-01-01T10:08:00Z', '2026-01-01T10:08:46Z'),
      run('2026-01-01T10:09:00Z', null, 999, 999),
      run(null, '2026-01-01T10:09:00Z', 999, 999),
    ]),
    { inputTokens: 1000, outputTokens: 50, durationMs: 506_000, steps: 2 },
  )
  assert.deepEqual(
    usageTotals([run('2026-01-01T10:00:00Z', '2026-01-01T10:00:46Z')]),
    { inputTokens: null, outputTokens: null, durationMs: 46_000, steps: 1 },
  )
})

test('a lead totals its own runs with every task that has a child ticket', () => {
  const task = (id: number, child: number | null) =>
    ({
      id,
      key: `task-${id}`,
      title: `Task ${id}`,
      status: 'running',
      child: child === null ? null : { number: child },
    }) as unknown as LeadTask
  const usage = ticketUsage(
    [run('2026-01-01T10:00:00Z', '2026-01-01T10:01:00Z', 100, 10)],
    [task(1, 7), task(2, null), task(3, 8)],
    new Map([[1, [run('2026-01-01T11:00:00Z', '2026-01-01T11:00:30Z', 5, 1)]]]),
  )
  assert.deepEqual(
    usage.tasks.map((row) => [row.taskId, row.ticketNumber, row.usage]),
    [
      [1, 7, { inputTokens: 5, outputTokens: 1, durationMs: 30_000, steps: 1 }],
      [
        3,
        8,
        { inputTokens: null, outputTokens: null, durationMs: 0, steps: 0 },
      ],
    ],
  )
  assert.deepEqual(usage.total, {
    inputTokens: 105,
    outputTokens: 11,
    durationMs: 90_000,
    steps: 2,
  })
})
