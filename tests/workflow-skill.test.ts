import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { describe, test } from 'node:test'
import {
  actions,
  CAPABILITIES,
  EXITS,
  humanContract,
  LIMIT,
  NEEDS_DECISION,
  roles,
} from '../src/domain/catalog.ts'
import { parseWorkflow } from '../src/domain/workflow.ts'

const guide = await readFile(
  new URL('../skills/kipster-workflows/SKILL.md', import.meta.url),
  'utf8',
)

const workflowExamples = [...guide.matchAll(/```yaml\n([\s\S]*?)```/g)]
  .map((match) => match[1] as string)
  .filter((source) => source.startsWith('name:'))

const builtIns = new URL('../workflows/', import.meta.url)

describe('workflow authoring skill', () => {
  test('every complete workflow example is valid', () => {
    assert.ok(workflowExamples.length >= 3)
    for (const source of workflowExamples) {
      const result = parseWorkflow(source)
      assert.ok(
        result.ok,
        `${source.split('\n')[0]}: ${result.ok ? '' : result.errors.join('; ')}`,
      )
    }
  })

  test('quotes built-in workflows exactly as their files', async () => {
    const quoted = new Map(
      workflowExamples.map((source) => [
        `${source.split('\n')[0]?.replace('name: ', '')}.yml`,
        source,
      ]),
    )
    for (const file of await readdir(builtIns)) {
      if (!quoted.has(file)) continue
      assert.equal(
        quoted.get(file),
        await readFile(new URL(file, builtIns), 'utf8'),
        `${file} differs from SKILL.md`,
      )
    }
  })

  test('names everything in the catalog', () => {
    const fixedOutcomes = Object.values(actions).flatMap((action) =>
      action === actions.decide ? [] : action.contract({}).outcomes,
    )
    const terms = [
      ...Object.keys(roles),
      ...Object.values(roles).flatMap((role) => role.outcomes),
      ...Object.keys(actions),
      ...Object.values(actions).flatMap((action) =>
        Object.keys((action.params as unknown as { shape: object }).shape),
      ),
      ...fixedOutcomes,
      ...humanContract.outcomes,
      ...CAPABILITIES,
      ...EXITS,
      NEEDS_DECISION,
      LIMIT,
    ]
    const missing = [...new Set(terms)].filter(
      (term) => !guide.includes(`\`${term}\``),
    )
    assert.deepEqual(missing, [], 'update skills/kipster-workflows/SKILL.md')
  })
})
