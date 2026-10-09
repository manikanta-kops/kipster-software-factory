import { readFileSync } from 'node:fs'

/** Follow the same file references as an agent; keep legacy content assertions useful. */
export function readPromptContext(prompt: string): string {
  return prompt.replace(/^Read file: ("[^\n]+")$/gm, (_, path: string) =>
    readFileSync(JSON.parse(path) as string, 'utf8'),
  )
}

export function promptJson<T = unknown>(prompt: string, heading: string): T {
  const reference = prompt.split(`${heading}\n`)[1]?.split('\n')[0]
  if (!reference?.startsWith('Read file: '))
    throw new Error(`Missing context: ${heading}`)
  const path = JSON.parse(reference.slice('Read file: '.length)) as string
  return JSON.parse(readFileSync(path, 'utf8')) as T
}
