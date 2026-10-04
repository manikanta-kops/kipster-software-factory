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
  if (child.pid) killProcessGroup(child.pid)
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
