import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { roles, type RoleName } from '../src/domain/catalog.ts'
import { renderRole } from '../src/domain/role.ts'
import { buildPrompt } from '../src/engine/prompt.ts'
import { loadTrustedInstructions } from '../src/kit/kit.ts'
import { autoMergeFixture } from './helpers/auto-merge.ts'

// Captured before this change at lead head d58038df682e2090bbf29696ee1c02f1091b4fd7.
const defaults = JSON.parse(
  await readFile(
    new URL('./fixtures/roles-default.json', import.meta.url),
    'utf8',
  ),
) as Record<RoleName, string>

const variants: Partial<
  Record<RoleName, { present: string[]; absent: string[] }>
> = {
  builder: {
    present: [
      'Report done or needs-other-repo.',
      'own separate commit',
      'commit message and summary',
      'Never report\nneeds-decision for this conflict.',
      'sensible default that can be completed in this repository',
    ],
    absent: [
      'Report done, needs-other-repo, or needs-decision.',
      'report needs-decision with the conflict',
      'If you cannot name a valid target or explain the required change, report needs-decision.',
    ],
  },
  reviewer: {
    present: [
      'do not block for scope\non that alone',
      'report passed with ownerReview',
      "names the path and the builder's stated reason",
      'Missing separation or explanation',
    ],
    absent: [
      'Changes to explicitly forbidden paths are serious scope problems',
    ],
  },
  reproducer: {
    present: [
      'try other entry points, inputs, data states and',
      'Record every attempt',
      'let the workflow route the',
      'it must never start a fix',
    ],
    absent: ['This outcome asks the owner'],
  },
  tester: {
    present: ['record it as a decision artifact', 'as the evidence shows'],
    absent: ['needs-decision with the evidence and precise question'],
  },
  lead: {
    present: [
      'treated as approved by the system',
      'For product or taste questions investigation cannot answer, choose the sensible default',
      'delegate a corrected task with a new key.',
      'Use `needs-decision` only for the irreversible actions',
    ],
    absent: [
      '`needs-decision` only for product or taste questions',
      'or report needs-decision',
      "do not ask again unless the owner's comments change the scope",
    ],
  },
  onboarder: {
    present: [
      'choose the sensible default for product decisions',
      'owner reviews kit changes on the',
      'never stop to ask',
    ],
    absent: [
      'ask the user only for product decisions',
      'or needs-decision for a product decision',
    ],
  },
  planner: {
    present: [
      'For questions investigation cannot answer, choose the sensible default',
      'Report done with the plan and recorded decisions.',
    ],
    absent: [
      'Ask only questions that investigation cannot answer.',
      'a product decision reports needs-decision',
    ],
  },
}

for (const role of Object.keys(roles) as RoleName[]) {
  test(`${role} prompt preserves default bytes and renders lights-out rules`, async (t) => {
    const f = await autoMergeFixture(t)
    const detail = await f.detail()
    const source = await readFile(
      new URL(`../src/roles/${role}.md`, import.meta.url),
      'utf8',
    )
    assert.equal(renderRole(source, { lightsOut: false }), defaults[role])
    for (const lightsOut of [false, true]) {
      const prompt = await buildPrompt({
        step: { id: 'role', kind: 'agent', role, needs: [], routes: {} },
        detail: { ...detail, ticket: { ...detail.ticket, lightsOut } },
        trusted: { roleInstructions: '', contextIndex: '' },
        directory: f.home,
        diff: '',
        home: f.home,
      })
      assert.doesNotMatch(prompt, /<!--\s*\/?(?:default|lights-out)\s*-->/)
      if (!lightsOut) {
        assert.equal(prompt.slice(0, defaults[role].length), defaults[role])
      } else {
        for (const sentence of variants[role]?.present ?? [])
          assert.ok(prompt.includes(sentence), `${role} missing ${sentence}`)
        for (const sentence of variants[role]?.absent ?? [])
          assert.ok(!prompt.includes(sentence), `${role} retained ${sentence}`)
        assert.ok(!prompt.includes('use it only for a product question'))
        assert.match(prompt, /Only irreversible actions wait/)
        assert.match(
          prompt,
          /"kind":"decision".*"chose".*"alternative".*"reason"/,
        )
        if (role === 'writer')
          assert.equal(renderRole(source, { lightsOut }), defaults[role])
      }
    }
  })
}

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

test('lights-out instructions are present only when enabled, with typed decision instructions', async (t) => {
  const f = await autoMergeFixture(t)
  const detail = await f.detail()
  for (const lightsOut of [false, true]) {
    const prompt = await buildPrompt({
      step: {
        id: 'build',
        kind: 'agent',
        role: 'builder',
        needs: [],
        routes: {},
      },
      detail: { ...detail, ticket: { ...detail.ticket, lightsOut } },
      trusted: { roleInstructions: '', contextIndex: '' },
      directory: f.home,
      diff: '',
      home: f.home,
    })
    assert.equal(prompt.includes('Lights-out is on.'), lightsOut)
    assert.match(prompt, /"kind":"decision".*"chose".*"alternative".*"reason"/)
    if (lightsOut) {
      assert.match(prompt, /Do not stop to ask/)
      assert.match(prompt, /Only irreversible actions wait/)
      assert.match(prompt, /merge gate and ownerReview rules still apply/)
    }
  }
})
