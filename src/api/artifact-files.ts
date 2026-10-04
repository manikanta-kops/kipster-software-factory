import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'

export type ArtifactFile =
  | {
      readonly ok: true
      readonly body: ReadableStream<Uint8Array>
      readonly type: string
      readonly size: number
    }
  | { readonly ok: false; readonly reason: 'outside-home' | 'missing' }

// HTML and anything unknown are sent as plain text or bytes so the browser never runs them.
const TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.html': 'text/plain; charset=utf-8',
}

/** Opens an artifact file only if it lies inside the factory home, after resolving symlinks. */
export async function openArtifactFile(
  home: string,
  path: string,
): Promise<ArtifactFile> {
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
    body: Readable.toWeb(createReadStream(real)) as ReadableStream<Uint8Array>,
    type: TYPES[extname(real).toLowerCase()] ?? 'application/octet-stream',
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
