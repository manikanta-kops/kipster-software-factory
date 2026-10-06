import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { constants } from 'node:os'

// Playwright refuses to reuse a server; allocating port 0 avoids parallel chats'
// fixed ports. Another process can still win the brief close-to-listen race.
const reservation = createServer()
await new Promise((resolve, reject) => {
  reservation.once('error', reject)
  reservation.listen(0, '127.0.0.1', resolve)
})
const address = reservation.address()
if (!address || typeof address === 'string') throw new Error('No test port')
const port = address.port
await new Promise((resolve, reject) =>
  reservation.close((error) => (error ? reject(error) : resolve())),
)
console.log(
  `KSF_E2E_PORT=${port}; npm run test:e2e (reuseExistingServer=false)`,
)
const child = spawn('npm', ['run', 'test:e2e'], {
  stdio: 'inherit',
  env: { ...process.env, KSF_E2E_PORT: String(port), VITE_API_BASE_URL: '' },
})
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(signal, () => child.kill(signal))
process.exitCode = await new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('exit', (code, signal) =>
    resolve(code ?? 128 + (signal ? constants.signals[signal] : 0)),
  )
})
