import { createReadStream } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { Readable } from 'node:stream'
import { fileType } from '../artifacts/outputs.ts'
import { byteRange } from './artifact-files.ts'

// Outputs share the factory's origin: the sandbox and connect-src/form-action keep pages away from the API.
// Opaque-origin pages load module scripts and fonts with CORS; the random id keeps `*` safe enough.
export const OUTPUT_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': [
    'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals',
    "default-src 'self' https: data: blob:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https: blob:",
    "style-src 'self' 'unsafe-inline' https:",
    "connect-src 'none'",
    "form-action 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Access-Control-Allow-Origin': '*',
  'Referrer-Policy': 'no-referrer',
}

export type OutputResponse =
  | { readonly kind: 'missing' }
  | { readonly kind: 'redirect'; readonly location: string }
  | { readonly kind: 'listing'; readonly html: string }
  | {
      readonly kind: 'file'
      readonly body: ReadableStream<Uint8Array> | null
      readonly type: string
      readonly size: number
      readonly status: 200 | 206 | 416
      readonly contentRange?: string
    }

const MISSING = { kind: 'missing' } as const

/** Resolves `/files/<id>/<rest>` inside `outputs/<id>`; folders open at index.html or as a list. */
export async function openOutput(
  home: string,
  id: string,
  pathname: string,
  range?: string,
): Promise<OutputResponse> {
  const prefix = `/files/${id}`
  const rest = pathname.slice(prefix.length)
  if (rest === '') return { kind: 'redirect', location: `${prefix}/` }
  const folder = rest.endsWith('/')
  const segments: string[] = []
  for (const raw of rest
    .slice(1)
    .split('/')
    .slice(0, folder ? -1 : undefined)) {
    let segment: string
    try {
      segment = decodeURIComponent(raw)
    } catch {
      return MISSING
    }
    if (['', '.', '..'].includes(segment) || /[/\\\0]/.test(segment))
      return MISSING
    segments.push(segment)
  }
  let root: string
  let real: string
  try {
    const outputs = join(await realpath(home), 'outputs')
    root = await realpath(join(outputs, id))
    if (root !== join(outputs, id)) return MISSING
    real = await realpath(join(root, ...segments))
  } catch {
    return MISSING
  }
  if (real !== root && !inside(root, real)) return MISSING
  const info = await stat(real)
  if (info.isDirectory()) {
    if (!folder) return { kind: 'redirect', location: `${pathname}/` }
    const index = join(real, 'index.html')
    const page = await stat(index).catch(() => null)
    if (page?.isFile()) return file(index, page.size, range)
    return { kind: 'listing', html: await listing(real, segments) }
  }
  if (!info.isFile() || folder) return MISSING
  return file(real, info.size, range)
}

function file(path: string, size: number, range?: string): OutputResponse {
  const base = fileType(path)
  const type =
    base.startsWith('text/') || base === 'application/json'
      ? `${base}; charset=utf-8`
      : base
  const selected = byteRange(range, size)
  if (selected === 'unsatisfiable')
    return {
      kind: 'file',
      body: null,
      type,
      size: 0,
      status: 416,
      contentRange: `bytes */${size}`,
    }
  return {
    kind: 'file',
    body: Readable.toWeb(
      createReadStream(path, selected),
    ) as ReadableStream<Uint8Array>,
    type,
    size: selected ? selected.end - selected.start + 1 : size,
    status: selected ? 206 : 200,
    ...(selected
      ? { contentRange: `bytes ${selected.start}-${selected.end}/${size}` }
      : {}),
  }
}

async function listing(folder: string, segments: readonly string[]) {
  const entries = (await readdir(folder, { withFileTypes: true }))
    .filter((entry) => entry.isFile() || entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
  const items = [
    ...(segments.length ? ['<li><a href="../">../</a></li>'] : []),
    ...entries.map((entry) => {
      const name = entry.isDirectory() ? `${entry.name}/` : entry.name
      const href = `${encodeURIComponent(entry.name)}${entry.isDirectory() ? '/' : ''}`
      return `<li><a href="${escape(href)}">${escape(name)}</a></li>`
    }),
  ]
  const title = escape(segments.length ? `${segments.join('/')}/` : 'Files')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;margin:2rem auto;max-width:48rem;padding:0 1rem}ul{padding-left:1.2rem}</style></head>
<body><h1>${title}</h1><ul>${items.join('')}</ul></body></html>`
}

function escape(text: string) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target)
  return (
    path !== '' &&
    path !== '..' &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  )
}
