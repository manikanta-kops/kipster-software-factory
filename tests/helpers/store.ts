import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { FactoryError } from '../../src/domain/errors.ts'
import {
  BUILT_IN_WORKFLOWS,
  type Library,
  type LibraryEntry,
  loadLibrary,
} from '../../src/library/library.ts'
import { type Database, openDatabase } from '../../src/store/database.ts'
import { migrate } from '../../src/store/migrate.ts'
import {
  createRepository,
  getRepository,
  markRepositoryReady,
} from '../../src/store/repositories.ts'
import { createTicket } from '../../src/store/tickets.ts'
import { createTestDatabase } from './database.ts'

let library: Library | undefined

/** A fresh copy each call, so uploads in one app never reach another. */
export async function builtInLibrary(): Promise<Map<string, LibraryEntry>> {
  if (!library) {
    const loaded = await loadLibrary(BUILT_IN_WORKFLOWS)
    if (!loaded.ok) throw new Error(loaded.errors.join('\n'))
    library = loaded.library
  }
  return new Map(library)
}

export async function builtInWorkflow(name: string): Promise<LibraryEntry> {
  const entry = (await builtInLibrary()).get(name)
  if (!entry) throw new Error(`No built-in workflow ${name}`)
  return entry
}

export async function testWorkflow(name: string): Promise<LibraryEntry> {
  const entry = (await testLibrary()).get(name)
  if (!entry) throw new Error(`No test workflow ${name}`)
  return entry
}

export interface TestStore {
  readonly url: string
  readonly database: Database
  close(): Promise<void>
}

/** A fresh, migrated database in the test cluster. */
export async function createTestStore(): Promise<TestStore> {
  const testDatabase = await createTestDatabase()
  const database = openDatabase(testDatabase.url)
  await migrate(database)
  return {
    url: testDatabase.url,
    database,
    async close() {
      await database.end()
      await testDatabase.drop()
    },
  }
}

/** Registers a ready repository and creates a planned-change ticket on it. */
export async function quickTicket(
  database: Database,
  options: { readonly repository?: string; readonly title?: string } = {},
) {
  const slug = options.repository ?? 'acme/shop'
  if (!(await getRepository(database, slug))) {
    const repository = await createRepository(database, { slug })
    await markRepositoryReady(database, repository.id)
  }
  return createTicket(database, {
    repository: slug,
    workflow: await testWorkflow('planned-change'),
    title: options.title ?? 'Add a dark mode toggle',
  })
}

export async function assertFactoryError(
  promise: Promise<unknown>,
  code: FactoryError['code'],
  pattern: RegExp,
) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof FactoryError, String(error))
    assert.equal(error.code, code)
    assert.match(error.message, pattern)
    return true
  })
}

export async function testLibrary(): Promise<Map<string, LibraryEntry>> {
  const fixtures = await loadLibrary(
    fileURLToPath(new URL('../fixtures/workflows/', import.meta.url)),
  )
  if (!fixtures.ok) throw new Error(fixtures.errors.join('\n'))
  return new Map([...(await builtInLibrary()), ...fixtures.library])
}
