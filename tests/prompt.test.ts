import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { test } from 'node:test'
import { buildPrompt } from '../src/engine/prompt.ts'
import { loadTrustedInstructions } from '../src/kit/kit.ts'
import { autoMergeFixture } from './helpers/auto-merge.ts'

test('agents are told to solve setup themselves and where the factory runtimes are', async (t) => {
  const f = await autoMergeFixture(t)
  const prompt = await buildPrompt({
    step: {
      id: 'build',
      kind: 'agent',
      role: 'builder',
      needs: [],
      routes: {},
    },
    detail: await f.detail(),
    trusted: await loadTrustedInstructions(
      f.cwd,
      'origin/main',
      'builder',
      f.signal,
    ),
    directory: f.home,
    diff: '',
    home: f.home,
  })
  assert.match(
    prompt,
    /needs-decision stops the ticket until the owner answers, so use it only for a product question/,
  )
  assert.match(
    prompt,
    /including the repository's \.kipster kit, are yours to solve/,
  )
  assert.ok(
    prompt.includes(
      `The factory runs Node ${process.version} from ${dirname(process.execPath)}`,
    ),
  )
})
