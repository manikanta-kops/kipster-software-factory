import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startScheduler } from '../../src/engine/scheduler.ts'
import { run } from '../../src/executors/process.ts'
import { openDatabase } from '../../src/store/database.ts'
import { listenForEvents } from '../../src/store/events.ts'
const [url, home, root] = process.argv.slice(2) as [string, string, string]
const database = openDatabase(url)
const events = listenForEvents(database)
await events.ready
await startScheduler({
  database,
  events,
  home,
  execute: async (invocation) => {
    await run(
      process.execPath,
      [
        fileURLToPath(new URL('./fake-agent.ts', import.meta.url)),
        invocation.directory,
        join(root, 'script.json'),
        root,
      ],
      { cwd: invocation.cwd, log: invocation.log, signal: invocation.signal },
    )
  },
})
console.log('started')
