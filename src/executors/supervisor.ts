// A separate supervisor survives a factory crash long enough to kill the agent group.
import { killProcessGroup } from './process-group.ts'
import { spawn } from 'node:child_process'
const [command, ...args] = process.argv.slice(2)
if (!command || !process.send)
  throw new Error('Executor supervisor requires IPC and a command')
const child = spawn(command, args, {
  detached: true,
  stdio: ['pipe', 'inherit', 'inherit'],
})
process.stdin.pipe(child.stdin)
child.stdin.on('error', () => {})
function kill() {
  try {
    if (child.pid) killProcessGroup(child.pid)
  } catch (error) {
    // A failed kill must not turn a requested stop into a crash of the wrapped command.
    console.error(error instanceof Error ? error.message : String(error))
  }
}
process.on('disconnect', kill)
process.on('message', kill)
process.on('SIGTERM', kill)
process.on('SIGINT', kill)
child.on('error', (error) => {
  console.error(error.message)
  process.exitCode = 1
})
child.on('close', (code) => {
  kill()
  process.stdin.destroy()
  if (process.connected) process.disconnect?.()
  process.exitCode = code ?? 1
})
