import { type DemoTickets, seedDemo } from '../../scripts/demo-data.ts'
import { builtInLibrary, createTestStore, type TestStore } from './store.ts'

/** A fresh database holding the demo repositories and tickets in every state. */
export async function createDemoStore(): Promise<
  TestStore & { readonly tickets: DemoTickets }
> {
  const store = await createTestStore()
  try {
    const tickets = await seedDemo(store.database, await builtInLibrary())
    return { ...store, tickets }
  } catch (error) {
    await store.close()
    throw error
  }
}
