import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { createApp } from '../src/api/app.ts'
import type { ErrorResponse, UpdateResponse } from '../src/api/contract.ts'
import { listenForEvents, type EventSignal } from '../src/store/events.ts'
import { startUpdater, type UpdaterOptions } from '../src/updater.ts'
import {
  installRelease,
  isNewer,
  latestRelease,
  type FailedUpdate,
} from '../src/updates.ts'
import {
  builtInLibrary,
  createTestStore,
  type TestStore,
} from './helpers/store.ts'
import { until } from './helpers/timing.ts'

async function serve(
  handler: Parameters<typeof createServer>[1],
): Promise<{ url: string; server: Server }> {
  const server = createServer(handler)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    server,
  }
}

test('release versions compare by number, not text', () => {
  assert.equal(isNewer('0.4.10', '0.4.9'), true)
  assert.equal(isNewer('0.5.0', '0.4.12'), true)
  assert.equal(isNewer('1.0.0', '0.9.9'), true)
  assert.equal(isNewer('0.4.3', '0.4.3'), false)
  assert.equal(isNewer('0.4.2', '0.4.3'), false)
  assert.equal(isNewer('0.5.0-rc.1', '0.4.3'), true)
})

test('the latest release comes from where GitHub redirects /releases/latest', async (t) => {
  const { url, server } = await serve((request, response) => {
    if (request.method === 'HEAD' && request.url === '/releases/latest')
      response.writeHead(302, {
        location: 'https://github.com/o/r/releases/tag/v0.5.1',
      })
    else response.writeHead(404)
    response.end()
  })
  t.after(() => server.close())
  assert.equal(await latestRelease(undefined, `${url}/releases`), '0.5.1')
  await assert.rejects(
    latestRelease(undefined, `${url}/missing`),
    /did not name the latest release \(HTTP 404\)/,
  )
})

test('an update runs the release installer only when it matches the release checksum', async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'ksf-update-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  const marker = join(work, 'ran')
  const script = `#!/bin/sh\nprintf '%s ' "$@" > '${marker}'\n`
  let checksum = createHash('sha256').update(script).digest('hex')
  const { url, server } = await serve((request, response) => {
    if (request.url === '/download/v0.5.1/install.sh') response.end(script)
    else if (request.url === '/download/v0.5.1/SHA256SUMS')
      response.end(
        `${'a'.repeat(64)}  kf-darwin-arm64.tar.gz\n${checksum}  install.sh\n`,
      )
    else response.writeHead(404).end()
  })
  t.after(() => server.close())

  checksum = 'b'.repeat(64)
  await assert.rejects(
    installRelease(work, '0.5.1', { start: true, releases: url }),
    /does not match the v0\.5\.1 checksum; nothing was installed/,
  )
  assert.equal(existsSync(marker), false)

  checksum = createHash('sha256').update(script).digest('hex')
  await installRelease(work, '0.5.1', { start: false, releases: url })
  assert.equal(
    (await readFile(marker, 'utf8')).trim(),
    `--home ${work} --version v0.5.1 --no-modify-path --no-start`,
  )
  await assert.rejects(
    installRelease(work, '0.9.9', { start: true, releases: url }),
    /HTTP 404/,
  )
})

function harness(overrides: Partial<UpdaterOptions> = {}) {
  const held: boolean[] = []
  const installs: string[] = []
  let busy = 0
  let failed: FailedUpdate | null = null
  const updater = startUpdater({
    current: '0.4.3',
    blocked: () => null,
    latest: async () => '0.4.4',
    scheduler: { hold: (value) => held.push(value), busy: () => busy },
    automatic: async () => true,
    install: async (version) => {
      installs.push(version)
    },
    failed: async () => failed,
    clearFailed: async () => {
      failed = null
    },
    now: () => new Date(2026, 9, 19, 14, 0),
    pollMs: 10,
    tickMs: 10,
    report: () => {},
    ...overrides,
  })
  return {
    updater,
    held,
    installs,
    setBusy: (value: number) => {
      busy = value
    },
    setFailed: (value: FailedUpdate | null) => {
      failed = value
    },
  }
}

describe('the updater', () => {
  test('holds new steps, waits for running ones, then installs', async (t) => {
    const h = harness()
    t.after(() => h.updater.close())
    await until(
      () => h.updater.status(),
      (s) => s.state === 'available',
    )
    h.setBusy(2)
    const waiting = await h.updater.request()
    assert.equal(waiting.state, 'waiting')
    assert.equal(waiting.running, 2)
    assert.deepEqual(h.held, [true])
    await new Promise((done) => setTimeout(done, 50))
    assert.deepEqual(h.installs, [])
    h.setBusy(0)
    await until(
      () => h.updater.status(),
      (s) => s.state === 'installing',
    )
    assert.deepEqual(h.installs, ['0.4.4'])
    await assert.rejects(h.updater.cancel(), /already installing/)
  })

  test('cancelling a waiting update releases the held steps', async (t) => {
    const h = harness()
    t.after(() => h.updater.close())
    h.setBusy(1)
    assert.equal((await h.updater.request()).state, 'waiting')
    const cancelled = await h.updater.cancel()
    assert.equal(cancelled.state, 'available')
    assert.deepEqual(h.held, [true, false])
    h.setBusy(0)
    await new Promise((done) => setTimeout(done, 50))
    assert.deepEqual(h.installs, [])
  })

  test('a blocked or current factory does not hold steps', async (t) => {
    const blocked = harness({ blocked: () => 'Runs from source.' })
    t.after(() => blocked.updater.close())
    await assert.rejects(blocked.updater.request(), /Runs from source/)
    assert.deepEqual(blocked.held, [])
    assert.equal((await blocked.updater.status()).blocked, 'Runs from source.')

    const current = harness({ latest: async () => '0.4.3' })
    t.after(() => current.updater.close())
    assert.equal((await current.updater.request()).state, 'none')
    assert.deepEqual(current.held, [])
  })

  test('a launch failure is reported and the held steps are released', async (t) => {
    const h = harness({
      install: async () => {
        throw new Error('launchctl refused')
      },
    })
    t.after(() => h.updater.close())
    const result = await h.updater.request()
    assert.equal(result.state, 'failed')
    assert.equal(result.error, 'launchctl refused')
    assert.deepEqual(h.held, [true, false])
  })

  test('a failed install of the latest release shows until retried', async (t) => {
    const h = harness()
    t.after(() => h.updater.close())
    h.setFailed({ version: '0.4.4', message: 'setup failed', at: '' })
    await until(
      () => h.updater.status(),
      (s) => s.state === 'failed',
    )
    assert.equal((await h.updater.status()).error, 'setup failed')
    await h.updater.request()
    await until(
      () => h.updater.status(),
      (s) => s.state === 'installing',
    )
    assert.deepEqual(h.installs, ['0.4.4'])
  })

  test('installs at night once when automatic updates are on', async (t) => {
    const night = harness({ now: () => new Date(2026, 9, 19, 3, 0) })
    t.after(() => night.updater.close())
    await until(
      async () => night.installs.length,
      (count) => count === 1,
    )
    await new Promise((done) => setTimeout(done, 50))
    assert.deepEqual(night.installs, ['0.4.4'])

    const off = harness({
      now: () => new Date(2026, 9, 19, 3, 0),
      automatic: async () => false,
    })
    t.after(() => off.updater.close())
    const failedBefore = harness({ now: () => new Date(2026, 9, 19, 3, 0) })
    failedBefore.setFailed({ version: '0.4.4', message: 'x', at: '' })
    t.after(() => failedBefore.updater.close())
    const day = harness()
    t.after(() => day.updater.close())
    await new Promise((done) => setTimeout(done, 80))
    assert.deepEqual(off.installs, [])
    assert.deepEqual(failedBefore.installs, [])
    assert.deepEqual(day.installs, [])
    assert.equal((await day.updater.status()).automatic, true)
  })
})

describe('the update API', () => {
  let store: TestStore
  let events: EventSignal
  let home: string
  before(async () => {
    store = await createTestStore()
    events = listenForEvents(store.database)
    await events.ready
    home = await mkdtemp(join(tmpdir(), 'ksf-update-api-'))
  })
  after(async () => {
    await events.close()
    await store.close()
    await rm(home, { recursive: true, force: true })
  })

  test('reports, requests and cancels an update', async (t) => {
    const h = harness()
    t.after(() => h.updater.close())
    const app = createApp({
      database: store.database,
      library: await builtInLibrary(),
      events,
      home,
      updates: h.updater,
    })
    await until(
      async () =>
        ((await (await app.request('/api/update')).json()) as UpdateResponse)
          .state,
      (state) => state === 'available',
    )
    const shown = (await (
      await app.request('/api/update')
    ).json()) as UpdateResponse
    assert.equal(shown.current, '0.4.3')
    assert.equal(shown.latest, '0.4.4')
    assert.equal(
      shown.notes,
      'https://github.com/manikanta-kops/kipster-software-factory/releases/tag/v0.4.4',
    )
    h.setBusy(1)
    const post = (path: string) =>
      app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    assert.equal(
      ((await (await post('/api/update')).json()) as UpdateResponse).state,
      'waiting',
    )
    assert.equal(
      ((await (await post('/api/update/cancel')).json()) as UpdateResponse)
        .state,
      'available',
    )
  })

  test('without an updater the factory reports its version and how to update', async () => {
    const app = createApp({
      database: store.database,
      library: await builtInLibrary(),
      events,
      home,
    })
    const shown = (await (
      await app.request('/api/update')
    ).json()) as UpdateResponse
    assert.equal(shown.state, 'none')
    assert.match(shown.blocked!, /Run kf update/)
    const refused = await app.request('/api/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    assert.equal(refused.status, 409)
    assert.match(((await refused.json()) as ErrorResponse).error, /kf update/)
  })
})
