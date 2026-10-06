import { startScheduler } from '../../src/engine/scheduler.ts'
import { openDatabase } from '../../src/store/database.ts'
import { listenForEvents } from '../../src/store/events.ts'
const database = openDatabase(process.argv[2]!)
const events = listenForEvents(database)
await events.ready
try {
  const scheduler = await startScheduler({
    database,
    events,
    home: '/unused-lock-probe',
  })
  await scheduler.close()
  process.exitCode = 1
} catch (error) {
  console.log(String(error))
} finally {
  await events.close()
  await database.end()
}
