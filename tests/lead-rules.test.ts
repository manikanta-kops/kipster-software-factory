import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildPrompt } from '../src/engine/prompt.ts'
import { autoMergeFixture } from './helpers/auto-merge.ts'

const rules = [
  'Work as fast as possible without lowering quality.',
  "Split work into the most tasks that can run in parallel safely: different files, no need for each other's result.",
  'Give them out together.',
  'A small ticket is one task.',
  "Sequence only tasks that need another's result or edit the same files.",
  "When one task needs another's result, delegate it after the first one reports `merged`.",
  'Give shared files (`docs/roadmap.md`, demo seed data, shared tests) to one task, not several.',
  "Write acceptance checks the checker can run: the running app, `npm run check`, `npm test` or the repository's equivalents.",
  "Tell the checker in each task's instructions that real tests count as proof for behaviour with no screen.",
  'A checker or final test that names no defect is not a failure: record what was unverified and move on.',
  'Never redo the same work or add demo data only for the checker.',
]

for (const lightsOut of [false, true]) {
  test(`lead prompt includes speed and quality rules with lights-out ${lightsOut}`, async (t) => {
    const f = await autoMergeFixture(t)
    const detail = await f.detail()
    const prompt = await buildPrompt({
      database: f.store.database,
      step: { id: 'lead', kind: 'agent', role: 'lead', needs: [], routes: {} },
      detail: { ...detail, ticket: { ...detail.ticket, lightsOut } },
      trusted: { roleInstructions: '', contextIndex: '' },
      directory: f.home,
      diff: '',
      home: f.home,
    })
    const prose = prompt.replace(/\s+/g, ' ')
    for (const rule of rules)
      assert.ok(prose.includes(rule), `Missing lead rule: ${rule}`)
    assert.equal(prompt.includes('Lights-out is on.'), lightsOut)
    assert.doesNotMatch(prompt, /<!--\s*\/?(?:default|lights-out)\s*-->/)
  })
}
