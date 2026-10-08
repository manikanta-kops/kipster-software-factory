import assert from 'node:assert/strict'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { otherRepositoriesFixture } from './helpers/other-repositories.ts'
import { setArtifactHome } from '../src/store/database.ts'
import {
  claimAttempts,
  linkOtherRepository,
  markRunning,
} from '../src/store/tickets.ts'
import { until } from './helpers/timing.ts'

test('linked result evidence is copied before its ticket lock, cleaned on rollback and retained once across replays', async (t) => {
  const f = await otherRepositoriesFixture()
  t.after(() => f.close())
  setArtifactHome(f.database, f.home)
  const original = await f.ticket()
  const [context] = await claimAttempts(f.database, 1)
  await markRunning(f.database, context!.attempt.id, 'fixture')
  const source = join(f.home, 'linked-proof.txt')
  await writeFile(source, 'Evidence from the original builder')
  const result = {
    outcome: 'needs-other-repo',
    summary: 'Library API needed',
    artifacts: [{ kind: 'evidence', title: 'Linked evidence', path: source }],
    otherRepository: {
      repository: 'fixture/library',
      workflow: 'lead',
      title: 'Expose API',
      body: 'Caller requires the API.',
    },
  }
  const directory = join(f.home, 'evidence', String(original.id))
  await f.database.query(
    "CREATE FUNCTION reject_link() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture link rollback'; END $$",
  )
  await f.database.query(
    'CREATE TRIGGER reject_link BEFORE INSERT ON ticket_links FOR EACH ROW EXECUTE FUNCTION reject_link()',
  )
  const connection = await f.database.connect()
  await connection.query('BEGIN')
  await connection.query(
    'SELECT id FROM tickets WHERE id = $1 FOR NO KEY UPDATE',
    [original.id],
  )
  const link = () =>
    linkOtherRepository(
      f.database,
      context!.attempt.id,
      result,
      f.library.get('lead')!,
      'a'.repeat(40),
    )
  const recording = link()
  await until(
    () => readdir(directory).catch(() => []),
    (entries) => entries.length > 0,
  )
  await connection.query('ROLLBACK')
  connection.release()
  await assert.rejects(recording, /fixture link rollback/)
  assert.deepEqual(await readdir(directory), [])
  assert.equal(
    await readFile(source, 'utf8'),
    'Evidence from the original builder',
  )
  await f.database.query('DROP TRIGGER reject_link ON ticket_links')
  const [first, replay] = await Promise.all([link(), link()])
  assert.equal(first.id, replay.id)
  const retained = (await f.detail(original.number)).artifacts.filter(
    (artifact) => artifact.title === 'Linked evidence',
  )
  assert.equal(retained.length, 1)
  assert.notEqual(retained[0]!.path, source)
  assert.equal(
    await readFile(retained[0]!.path!, 'utf8'),
    'Evidence from the original builder',
  )
  assert.equal((await readdir(directory)).length, 1)
  await rm(source)
  assert.equal((await link()).id, first.id)
  assert.equal((await readdir(directory)).length, 1)
})
