import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { type DemoTickets, seedDemo } from '../../scripts/demo-data.ts'
import { builtInLibrary, createTestStore, type TestStore } from './store.ts'

/** A fresh database holding the demo repositories and tickets in every state. */
export async function createDemoStore(): Promise<
  TestStore & { readonly home: string; readonly tickets: DemoTickets }
> {
  const store = await createTestStore()
  const home = await mkdtemp(join(tmpdir(), 'demo-home-'))
  try {
    const tickets = await seedDemo(store.database, await builtInLibrary(), home)
    return {
      ...store,
      home,
      tickets,
      async close() {
        await store.close()
        await rm(home, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await store.close()
    await rm(home, { recursive: true, force: true })
    throw error
  }
}
