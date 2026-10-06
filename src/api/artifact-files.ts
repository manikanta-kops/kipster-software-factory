import { detectMediaType } from '../artifacts/media-type.ts'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'

export type ArtifactFile =
  | {
      readonly ok: true
      readonly body: ReadableStream<Uint8Array> | null
      readonly type: string
      readonly size: number
      readonly status: 200 | 206 | 416
      readonly contentRange?: string
    }
  | { readonly ok: false; readonly reason: 'outside-home' | 'missing' }

/** Opens an artifact file only if it lies inside the factory home, after resolving symlinks. */
export async function inspectArtifactFile(
  home: string,
  path: string,
): Promise<
  | { ok: true; path: string; type: string; size: number }
  | { ok: false; reason: 'outside-home' | 'missing' }
> {
  const root = resolve(home)
  if (!inside(root, resolve(root, path))) {
    return { ok: false, reason: 'outside-home' }
  }
  let realRoot: string
  let real: string
  try {
    realRoot = await realpath(root)
    real = await realpath(resolve(root, path))
  } catch {
    return { ok: false, reason: 'missing' }
  }
  if (!inside(realRoot, real)) return { ok: false, reason: 'outside-home' }
  const info = await stat(real)
  if (!info.isFile()) return { ok: false, reason: 'missing' }
  return {
    ok: true,
    path: real,
    type: await detectMediaType(real),
    size: info.size,
  }
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

export async function openArtifactFile(
  home: string,
  path: string,
  range?: string,
): Promise<ArtifactFile> {
  const file = await inspectArtifactFile(home, path)
  if (!file.ok) return file
  const selected = byteRange(range, file.size)
  const type = file.type.startsWith('text/')
    ? `${file.type}; charset=utf-8`
    : file.type
  if (selected === 'unsatisfiable')
    return {
      ok: true,
      body: null,
      type,
      size: 0,
      status: 416,
      contentRange: `bytes */${file.size}`,
    }
  return {
    ok: true,
    body: Readable.toWeb(
      createReadStream(file.path, selected),
    ) as ReadableStream<Uint8Array>,
    type,
    size: selected ? selected.end - selected.start + 1 : file.size,
    status: selected ? 206 : 200,
    ...(selected
      ? { contentRange: `bytes ${selected.start}-${selected.end}/${file.size}` }
      : {}),
  }
}

function byteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | undefined {
  // Ignore unsupported units, multipart and malformed ranges; serve the full file.
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header?.trim() ?? '')
  if (!match || (!match[1] && !match[2])) return
  const first = match[1] ? Number(match[1]) : undefined
  const last = match[2] ? Number(match[2]) : undefined
  if ([first, last].some((n) => n !== undefined && !Number.isSafeInteger(n)))
    return
  if (first !== undefined && last !== undefined && last < first) return
  if (
    !size ||
    (first !== undefined && first >= size) ||
    (first === undefined && last === 0)
  )
    return 'unsatisfiable'
  return {
    start: first ?? Math.max(0, size - last!),
    end: first === undefined ? size - 1 : Math.min(last ?? size - 1, size - 1),
  }
}
