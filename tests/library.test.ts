import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import {
  BUILT_IN_WORKFLOWS,
  loadLibrary,
  workflowVersion,
} from '../src/library/library.ts'

const directories: string[] = []
after(() =>
  Promise.all(
    directories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  ),
)

async function directoryWith(files: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), 'ksf-library-'))
  directories.push(directory)
  for (const [name, source] of Object.entries(files)) {
    await writeFile(join(directory, name), source)
  }
  return directory
}

describe('loadLibrary', () => {
  test('loads every built-in workflow', async () => {
    const result = await loadLibrary(BUILT_IN_WORKFLOWS)
    if (!result.ok) assert.fail(result.errors.join('\n'))
    assert.deepEqual([...result.library.keys()].sort(), [
      'bug',
      'lead',
      'onboard-repo',
      'task',
      'task-pr',
    ])
  })

  test('lead bounds twenty tasks and fifty reports', async () => {
    const result = await loadLibrary(BUILT_IN_WORKFLOWS)
    if (!result.ok) assert.fail(result.errors.join('\n'))
    const step = result.library
      .get('lead')!
      .workflow.steps.find((candidate) => candidate.id === 'run-tasks')!
    assert.equal(step.limit, 50)
    assert.equal(step.kind === 'system' && step.with?.maxTasks, 20)
  })

  test('versions are content hashes', () => {
    assert.equal(workflowVersion('a'), workflowVersion('a'))
    assert.notEqual(workflowVersion('a'), workflowVersion('b'))
  })

  test('requires the workflow name to match its file', async () => {
    const directory = await directoryWith({
      'other.yml':
        'name: sample\ndescription: x\nsteps:\n  - id: a\n    kind: human\n',
    })
    const result = await loadLibrary(directory)
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.errors.join(), /must match the file/)
  })

  test('reports an empty directory', async () => {
    const result = await loadLibrary(await directoryWith({}))
    assert.equal(result.ok, false)
  })
})
