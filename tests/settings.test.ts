import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { createApp } from '../src/api/app.ts'
import type { ErrorResponse, SettingsResponse } from '../src/api/contract.ts'
import { readConfig, settingsFromConfig } from '../src/config.ts'
import {
  DEFAULT_SETTINGS,
  resolveAgent,
  type Settings,
  settingsProblems,
  settingsSchema,
  stepTimeoutFor,
} from '../src/domain/settings.ts'
import { listenForEvents, type EventSignal } from '../src/store/events.ts'
import { effectiveSettings, saveSettings } from '../src/store/settings.ts'
import {
  builtInLibrary,
  createTestStore,
  type TestStore,
} from './helpers/store.ts'

const sol = { cli: 'codex', model: 'gpt-6.1-sol', effort: 'high' } as const
const opusMedium = {
  cli: 'claude',
  model: 'claude-opus-5-5',
  effort: 'medium',
} as const
const opusHigh = { ...opusMedium, effort: 'high' } as const
const planner = { cli: 'claude', model: 'claude-sonnet-5-5' } as const

const overridden: Settings = {
  ...DEFAULT_SETTINGS,
  agents: { default: { cli: 'codex' }, roles: { planner }, allowed: [] },
  workflows: {
    'data-task': {
      stepTimeoutMinutes: 240,
      roles: { builder: sol, reviewer: opusMedium },
    },
  },
}

describe('settings resolution', () => {
  test('task agent sets only the builder, then workflow, role and default', () => {
    const at = (workflow: string, role: 'builder' | 'reviewer') =>
      ({ workflow, role }) as const
    assert.deepEqual(
      resolveAgent(overridden, {
        ...at('data-task', 'builder'),
        taskAgent: opusHigh,
      }),
      opusHigh,
    )
    assert.deepEqual(
      resolveAgent(overridden, {
        ...at('data-task', 'reviewer'),
        taskAgent: opusHigh,
      }),
      opusMedium,
    )
    assert.deepEqual(resolveAgent(overridden, at('data-task', 'builder')), sol)
    for (const role of ['tester', 'reproducer', 'writer'] as const)
      assert.deepEqual(
        resolveAgent(overridden, {
          workflow: 'data-task',
          role,
          taskAgent: opusHigh,
        }),
        { cli: 'codex' },
      )
    assert.deepEqual(
      resolveAgent(overridden, { workflow: 'lead', role: 'planner' }),
      planner,
    )
    assert.deepEqual(
      resolveAgent(overridden, { workflow: 'lead', role: 'reviewer' }),
      { cli: 'codex' },
    )
    assert.equal(stepTimeoutFor(overridden, 'data-task'), 240)
    assert.equal(stepTimeoutFor(overridden, 'lead'), 120)
    assert.equal(stepTimeoutFor({ stepTimeoutMinutes: 30 }, 'data-task'), 30)
  })

  test('the default step timeout is 120 minutes', async (t) => {
    const home = await mkdtemp(join(tmpdir(), 'ksf-settings-config-'))
    t.after(() => rm(home, { recursive: true, force: true }))
    await writeFile(join(home, 'config.json'), '{}')
    const config = await readConfig(home)
    assert.deepEqual(settingsFromConfig(config), DEFAULT_SETTINGS)
    assert.equal(DEFAULT_SETTINGS.stepTimeoutMinutes, 120)
  })

  test('overrides must name a known workflow', () => {
    assert.deepEqual(settingsProblems(overridden, ['data-task']), [])
    assert.deepEqual(settingsProblems(overridden, ['lead']), [
      'workflows.data-task: unknown workflow',
    ])
    assert.equal(settingsSchema.safeParse(overridden).success, true)
  })
})

describe('settings store and API', () => {
  let store: TestStore
  let events: EventSignal
  let home: string
  let app: ReturnType<typeof createApp>
  // What an install's config.json gives today.
  const fromConfig: Settings = {
    concurrency: 3,
    stepTimeoutMinutes: 90,
    agents: {
      default: { cli: 'claude' },
      roles: { reviewer: opusMedium },
      allowed: [opusHigh],
    },
    workflows: {},
  }

  before(async () => {
    store = await createTestStore()
    events = listenForEvents(store.database)
    await events.ready
    home = await mkdtemp(join(tmpdir(), 'ksf-settings-'))
    const library = await builtInLibrary()
    library.set('data-task', { ...library.get('task')! })
    app = createApp({
      database: store.database,
      library,
      events,
      home,
      settings: fromConfig,
    })
  })
  after(async () => {
    await events.close()
    await store.close()
    await rm(home, { recursive: true, force: true })
  })

  const get = async () => {
    const response = await app.request('/api/settings')
    assert.equal(response.status, 200)
    return (await response.json()) as SettingsResponse
  }
  const post = (body: unknown, type = 'application/json') =>
    app.request('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': type },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })

  test('without saved settings the config.json values apply unchanged', async () => {
    const response = await get()
    assert.deepEqual(response.settings, fromConfig)
    assert.equal(response.source, 'config')
    assert.equal(response.updatedAt, null)
    assert.deepEqual(response.choices.clis, ['codex', 'claude'])
    assert.ok(response.choices.efforts.includes('high'))
    assert.ok(response.choices.roles.includes('reviewer'))
    assert.ok(response.workflows.includes('data-task'))
    assert.ok(response.workflows.includes('lead'))
  })

  test('invalid settings are rejected with a named issue and nothing is saved', async () => {
    const cases: [unknown, RegExp][] = [
      [
        {
          ...fromConfig,
          agents: { ...fromConfig.agents, default: { cli: 'gpt' } },
        },
        /^agents\.default\.cli: unknown CLI/,
      ],
      [
        {
          ...fromConfig,
          agents: {
            ...fromConfig.agents,
            allowed: [{ cli: 'claude', effort: 'huge' }],
          },
        },
        /^agents\.allowed\.0\.effort: unknown effort/,
      ],
      [
        { ...fromConfig, concurrency: 0 },
        /^concurrency: must be a positive integer/,
      ],
      [
        { ...fromConfig, concurrency: -1 },
        /^concurrency: must be a positive integer/,
      ],
      [
        { ...fromConfig, concurrency: 1.5 },
        /^concurrency: must be a positive integer/,
      ],
      [
        { ...fromConfig, stepTimeoutMinutes: 0 },
        /^stepTimeoutMinutes: must be a positive/,
      ],
      [
        { ...fromConfig, workflows: { nope: { stepTimeoutMinutes: 5 } } },
        /^workflows\.nope: unknown workflow/,
      ],
      [
        {
          ...fromConfig,
          agents: {
            ...fromConfig.agents,
            roles: { designer: { cli: 'claude' } },
          },
        },
        /^agents\.roles: Unrecognized key: "designer"/,
      ],
      [
        {
          ...fromConfig,
          workflows: { 'data-task': { roles: { designer: { cli: 'codex' } } } },
        },
        /^workflows\.data-task\.roles: Unrecognized key: "designer"/,
      ],
    ]
    for (const [body, issue] of cases) {
      const response = await post(body)
      assert.equal(response.status, 400, JSON.stringify(body))
      const error = (await response.json()) as ErrorResponse
      assert.ok(
        error.issues?.some((item) => issue.test(item)),
        `${JSON.stringify(error)} should match ${issue}`,
      )
    }
    const text = await post(JSON.stringify(fromConfig), 'text/plain')
    assert.equal(text.status, 400)
    assert.match(((await text.json()) as ErrorResponse).error, /as JSON/)
    const unchanged = await get()
    assert.equal(unchanged.source, 'config')
    assert.deepEqual(unchanged.settings, fromConfig)
  })

  test('saved settings replace config.json and survive reads', async () => {
    const saved: Settings = {
      ...fromConfig,
      concurrency: 4,
      stepTimeoutMinutes: 240,
      workflows: overridden.workflows,
    }
    const response = await post(saved)
    assert.equal(response.status, 200)
    const body = (await response.json()) as SettingsResponse
    assert.deepEqual(body.settings, saved)
    assert.equal(body.source, 'saved')
    assert.ok(body.updatedAt)
    const read = await get()
    assert.deepEqual(read.settings, saved)
    assert.equal(read.source, 'saved')
  })

  test('an unreadable saved row falls back to config.json instead of stopping the factory', async () => {
    await store.database.query(
      `UPDATE settings SET engine = '{"concurrency": "many"}'`,
    )
    const errors: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => errors.push(args)
    try {
      const effective = await effectiveSettings(store.database, fromConfig)
      assert.equal(effective.source, 'config')
      assert.deepEqual(effective.settings, fromConfig)
    } finally {
      console.error = original
    }
    assert.equal(errors.length, 1)
    await saveSettings(store.database, DEFAULT_SETTINGS)
    assert.deepEqual(
      (await effectiveSettings(store.database, fromConfig)).settings,
      DEFAULT_SETTINGS,
    )
  })
})
