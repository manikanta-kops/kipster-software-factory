import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const [port, databaseUrl, mode] = process.argv.slice(2)
console.log('fixture start', mode ?? 'ready')
if (mode === 'crash') {
  console.error('fixture intentional crash')
  process.exit(7)
}
if (mode === 'child') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'inherit',
  })
  writeFileSync('child.pid', String(child.pid))
}
const fixed =
  existsSync('behaviour.txt') &&
  readFileSync('behaviour.txt', 'utf8').trim() === 'fixed'
createServer((request, response) => {
  if (request.url === '/checkout' && request.method === 'POST') {
    response.writeHead(fixed ? 200 : 500, {
      'content-type': 'application/json',
    })
    response.end(
      JSON.stringify({
        message: fixed ? 'Order placed' : 'Checkout failed',
        pid: process.pid,
      }),
    )
    return
  }
  response.writeHead(mode === 'timeout' ? 503 : 200, {
    'content-type': 'application/json',
  })
  response.end(JSON.stringify({ databaseUrl, pid: process.pid }))
}).listen(Number(port), '127.0.0.1')
if (mode === 'later-crash') setTimeout(() => process.exit(8), 1500)
