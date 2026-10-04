import { detectMediaType } from '../artifacts/media-type.ts'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'

export type ArtifactFile =
  | {
      readonly ok: true
      readonly body: ReadableStream<Uint8Array>
      readonly type: string
      readonly size: number
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
): Promise<ArtifactFile> {
  const file = await inspectArtifactFile(home, path)
  if (!file.ok) return file
  return {
    ok: true,
    body: Readable.toWeb(
      createReadStream(file.path),
    ) as ReadableStream<Uint8Array>,
    type: file.type.startsWith('text/')
      ? `${file.type}; charset=utf-8`
      : file.type,
    size: file.size,
  }
}
