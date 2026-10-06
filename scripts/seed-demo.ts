// Fills a database with demo repositories and tickets in every state.
// Usage: npm run seed:demo [-- --database-url <url>]
// Without --database-url it seeds the development database that `npm run dev` uses.
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { BUILT_IN_WORKFLOWS, loadLibrary } from '../src/library/library.ts'
import { openDatabase } from '../src/store/database.ts'
import { seedDemo } from './demo-data.ts'
import {
  root,
  devCluster,
  devDatabaseUrl,
  ensureDevDatabase,
} from './dev-database.ts'
import {
  isClusterRunning,
  startCluster,
  stopCluster,
} from '../src/store/cluster.ts'

const { values } = parseArgs({
  options: { 'database-url': { type: 'string' }, home: { type: 'string' } },
})

const loaded = await loadLibrary(BUILT_IN_WORKFLOWS)
if (!loaded.ok) throw new Error(loaded.errors.join('\n'))

let url = values['database-url']
const startedCluster = url === undefined && !isClusterRunning(devCluster)
if (url === undefined) {
  if (startedCluster) startCluster(devCluster)
  await ensureDevDatabase()
  url = devDatabaseUrl
}

const database = openDatabase(url)
try {
  const tickets = await seedDemo(
    database,
    loaded.library,
    values.home ?? join(root, '.local', 'factory'),
  )
  console.log('Seeded demo tickets:')
  for (const [state, number] of Object.entries(tickets)) {
    console.log(`  #${number}  ${state}`)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await database.end()
  if (startedCluster) stopCluster(devCluster)
}
