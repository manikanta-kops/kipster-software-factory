import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildPrompt } from '../src/engine/prompt.ts'
import { addAttemptArtifacts } from '../src/store/tickets.ts'
import { autoMergeFixture } from './helpers/auto-merge.ts'

test('reviewer can audit retained tester evidence after instance scratch cleanup', async (t) => {
  const f = await autoMergeFixture(t)
  const tester = (await f.detail()).attempts.find((a) => a.stepId === 'test')!
  const source = join(f.home, 'instance-observations.json')
  await writeFile(source, JSON.stringify({ visible: 3, fetched: 3 }))
  await addAttemptArtifacts(
    f.store.database,
    tester.id,
    [
      {
        kind: 'evidence',
        title: 'Actual browser observations',
        path: source,
        scenario: 'All events',
        scenarioResult: 'passed',
      },
    ],
    { commit: f.head() },
  )
  await rm(source)
  const detail = await f.detail()
  const retained = detail.artifacts.find(
    (a) => a.title === 'Actual browser observations',
  )!
  assert.notEqual(retained.path, source)
  const prompt = await buildPrompt({
    step: {
      id: 'review',
      kind: 'agent',
      role: 'reviewer',
      needs: [],
      routes: {},
    },
    detail,
    cwd: f.cwd,
    directory: f.home,
    diff: 'Activity caption and focused browser test',
    home: f.home,
  })
  const manifest = JSON.parse(
    prompt
      .split(
        'Retained verification artifacts (factory-owned copies; inspect these paths, not scratch paths from an earlier result.json):\n',
      )[1]!
      .split('\n\n')[0]!,
  )
  const reference = manifest.find((a: { id: number }) => a.id === retained.id)
  assert.equal(reference.path, retained.path)
  assert.equal(reference.observedCommit, f.head())
  assert.equal(reference.attempt, tester.id)
  assert.equal(reference.scenario, 'All events')
  assert.equal(reference.scenarioResult, 'passed')
  assert.deepEqual(JSON.parse(await readFile(reference.path, 'utf8')), {
    visible: 3,
    fetched: 3,
  })
})
