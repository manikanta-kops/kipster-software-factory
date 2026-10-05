import assert from 'node:assert/strict'
import { test } from 'node:test'
import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDemoStore } from './helpers/demo.ts'
import {
  addAttemptArtifacts,
  completeAttempt,
  getTicketDetail,
} from '../src/store/tickets.ts'
import { scenarioIndex } from '../src/domain/evidence.ts'
import { adoptEvidence, pruneEvidence } from '../src/store/evidence.ts'
import { retainArtifact } from '../src/artifacts/storage.ts'
import { createApp } from '../src/api/app.ts'
import { builtInLibrary } from './helpers/store.ts'
import { listenForEvents } from '../src/store/events.ts'

test('recorded files are factory-owned per ticket, scenario index prefers key visuals, archive remains accessible', async (t) => {
  const f = await createDemoStore()
  t.after(() => f.close())
  const detail = (await getTicketDetail(f.database, f.tickets.proofPassed))!
  const evidence = detail.artifacts.filter((a) => a.kind === 'evidence')
  assert.ok(
    evidence.every((a) =>
      a.path!.startsWith(
        join(f.home, 'evidence', String(detail.ticket.id)) + '/',
      ),
    ),
  )
  const roles = new Map([['test', 'tester']])
  const index = scenarioIndex(
    detail.artifacts,
    detail.attempts,
    roles,
    'a'.repeat(40),
  )
  assert.equal(index.length, 1)
  assert.equal(index[0]!.scenario, 'Cart quantity updates the total')
  assert.equal(index[0]!.result, 'passed')
  assert.equal(index[0]!.current, true)
  assert.equal(
    detail.artifacts.find((a) => a.id === index[0]!.artifactId)!.mediaType,
    'image/png',
  )
  assert.equal(
    scenarioIndex(detail.artifacts, detail.attempts, roles, 'b'.repeat(40))[0]!
      .current,
    false,
  )
  const source = join(f.home, 'scratch.log')
  await writeFile(source, 'retained log')
  await addAttemptArtifacts(f.database, detail.attempts.at(-1)!.id, [
    { kind: 'log', title: 'copied log', path: source },
  ])
  await writeFile(source, 'later changed')
  const copied = (await getTicketDetail(
    f.database,
    f.tickets.proofPassed,
  ))!.artifacts.at(-1)!
  assert.equal(await readFile(copied.path!, 'utf8'), 'retained log')
})

test('storage rejects source and destination symlink escapes', async (t) => {
  const f = await createDemoStore()
  t.after(() => f.close())
  await symlink('/etc/hosts', join(f.home, 'escape'))
  await assert.rejects(
    retainArtifact(f.home, 1, {
      kind: 'evidence',
      title: 'unsafe',
      path: 'escape',
    }),
    /outside-home/,
  )
  await mkdir(join(f.home, 'outside'))
  await symlink(join(f.home, 'outside'), join(f.home, 'evidence', '999'))
  await writeFile(join(f.home, 'safe.txt'), 'safe')
  await assert.rejects(
    retainArtifact(f.home, 999, {
      kind: 'evidence',
      title: 'unsafe target',
      path: 'safe.txt',
    }),
    /symlinks/,
  )
})

test('retention uses the injected clock, keeps final curated evidence, never prunes unfinished tickets and preserves rows', async (t) => {
  const f = await createDemoStore()
  let events: ReturnType<typeof listenForEvents> | undefined
  t.after(async () => {
    await events?.close()
    await f.close()
  })
  const unfinished = (await getTicketDetail(f.database, f.tickets.proofStale))!
  const finished = (await getTicketDetail(f.database, f.tickets.proofPassed))!
  await addAttemptArtifacts(f.database, finished.ticket.waiting!.attemptId, [
    { kind: 'evidence', title: 'archive note', content: 'old output' },
  ])
  await completeAttempt(
    f.database,
    finished.ticket.waiting!.attemptId,
    { outcome: 'merged', summary: 'Owner merged', artifacts: [] },
    { headCommit: 'a'.repeat(40) },
  )
  const current = (await getTicketDetail(f.database, finished.ticket.number))!
  const end = new Date(current.ticket.updatedAt)
  assert.equal(
    await pruneEvidence(
      f.database,
      f.home,
      30,
      new Date(end.getTime() + 29 * 86400000),
    ),
    0,
  )
  const now = new Date(end.getTime() + 31 * 86400000)
  const count = await pruneEvidence(f.database, f.home, 30, now)
  assert.equal(count, 3, 'recording, log and inline archive evidence expire')
  const after = (await getTicketDetail(f.database, finished.ticket.number))!
  const kept = after.artifacts.find((a) => a.mediaType === 'image/png')!
  assert.equal(kept.prunedAt, null)
  await access(kept.path!)
  const removed = after.artifacts.filter((a) => a.prunedAt)
  assert.equal(removed.length, 3)
  assert.ok(removed.every((a) => a.retentionDays === 30))
  for (const artifact of removed.filter((a) => a.path))
    await assert.rejects(access(artifact.path!))
  assert.equal(
    (await getTicketDetail(
      f.database,
      unfinished.ticket.number,
    ))!.artifacts.filter((a) => a.prunedAt).length,
    0,
  )
  assert.equal(await pruneEvidence(f.database, f.home, 30, now), 0)
  events = listenForEvents(f.database)
  await events.ready
  const app = createApp({
    database: f.database,
    home: f.home,
    library: await builtInLibrary(),
    events,
  })
  const response = await app.request(`/api/artifacts/${removed[0]!.id}`)
  assert.equal(response.status, 410)
  assert.match(await response.text(), /removed after 30 days/)
})

test('adopting with a non-canonical home never re-copies retained files', async (t) => {
  const f = await createDemoStore()
  t.after(() => f.close())
  const paths = async () =>
    (
      await f.database.query<{ path: string }>(
        'SELECT path FROM artifacts WHERE path IS NOT NULL ORDER BY id',
      )
    ).rows.map((row) => row.path)
  const before = await paths()
  await adoptEvidence(f.database, `${f.home}/`)
  await adoptEvidence(f.database, join(f.home, '.'))
  assert.deepEqual(await paths(), before)
})
