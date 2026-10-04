import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { finished } from 'node:stream/promises'

export async function run(
  command: string,
  args: readonly string[],
  options: {
    cwd?: string
    input?: string
    log?: string
    signal?: AbortSignal
  } = {},
): Promise<string> {
  options.signal?.throwIfAborted()
  const log = options.log
    ? createWriteStream(options.log, { flags: 'a' })
    : undefined
  const logDone = log ? finished(log) : Promise.resolve()
  // Attach immediately so a disk error cannot become an unhandled rejection.
  void logDone.catch(() => {})
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./supervisor.ts', import.meta.url)),
      command,
      ...args,
    ],
    {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    },
  )
  let output = ''
  let diagnostic = ''
  const abort = () => {
    if (child.connected) child.send('stop', () => {})
  }
  options.signal?.addEventListener('abort', abort, { once: true })
  let logFailed = false
  log?.on('error', () => {
    logFailed = true
    abort()
    child.stdout?.resume()
    child.stderr?.resume()
  })
  for (const stream of [child.stdout!, child.stderr!]) {
    stream.on('data', (data: Buffer) => {
      if (log && !logFailed) {
        if (!log.write(data)) {
          stream.pause()
          log.once('drain', () => stream.resume())
        }
      } else if (stream === child.stdout)
        output = (output + data.toString()).slice(-4_000_000)
      else diagnostic = (diagnostic + data.toString()).slice(-4000)
    })
  }
  child.stdin!.on('error', () => {})
  child.stdin!.end(options.input ?? '')
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', resolve)
    })
    options.signal?.throwIfAborted()
    if (code !== 0)
      throw new Error(
        `${command} exited ${code}: ${diagnostic || output.slice(-4000) || options.log || ''}`,
      )
    return output.trim()
  } finally {
    options.signal?.removeEventListener('abort', abort)
    log?.end()
    await logDone
  }
}
