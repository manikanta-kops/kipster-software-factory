import { createInterface } from 'node:readline/promises'

export async function pipedSecret(): Promise<string> {
  let value = ''
  for await (const chunk of process.stdin) {
    value += String(chunk)
    if (value.length > 1_000_000) throw new Error('Secret input is too large.')
  }
  return value.replace(/\r?\n$/, '')
}
export async function hiddenInput(label: string): Promise<string> {
  if (!process.stdin.isTTY)
    throw new Error(
      'Hidden input needs a terminal; pipe the secret through stdin.',
    )
  process.stdout.write(label)
  const wasRaw = process.stdin.isRaw
  process.stdin.setRawMode(true)
  process.stdin.resume()
  return new Promise<string>((resolve, reject) => {
    let value = ''
    const finish = (cancelled = false) => {
      process.stdin.off('data', read)
      process.stdin.setRawMode(wasRaw)
      process.stdin.pause()
      process.stdout.write('\n')
      if (cancelled) reject(new Error('Input cancelled.'))
      else resolve(value)
    }
    const read = (data: Buffer) => {
      for (const character of data.toString()) {
        if (character === '\u0003' || character === '\u0004') {
          finish(true)
          return
        }
        if (character === '\r' || character === '\n') {
          finish()
          return
        }
        if (character === '\u007f' || character === '\b')
          value = value.slice(0, -1)
        else if (character >= ' ') value += character
      }
    }
    process.stdin.on('data', read)
  })
}
export async function prompt(label: string, current: string): Promise<string> {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  try {
    return (
      (
        await terminal.question(`${label}${current ? ` [${current}]` : ''}: `)
      ).trim() || current
    )
  } finally {
    terminal.close()
  }
}
