import { randomUUID } from 'node:crypto'
import {
  constants,
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises'
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'

export const MAX_OUTPUT_BYTES = 500 * 1024 * 1024

const RETAINED = /[/\\]outputs[/\\]([0-9a-f-]{36})(?:[/\\]([^/\\]+))?$/

/** Checks an agent's output: a file or folder inside the home, made only of real files and folders, within the size cap. */
export async function checkOutput(
  home: string,
  path: string,
  limit = MAX_OUTPUT_BYTES,
): Promise<{ path: string; folder: boolean }> {
  const root = await realpath(home)
  const given = resolve(home, path)
  let real: string
  try {
    if ((await lstat(given)).isSymbolicLink())
      throw new Error(`Output ${path} is a link; publish the files themselves`)
    real = await realpath(given)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`Output ${path} does not exist`, { cause: error })
    throw error
  }
  if (!inside(root, real))
    throw new Error(`Output ${path} must be inside the factory home ${home}`)
  const info = await lstat(real)
  if (info.isFile()) {
    tooLarge(path, info.size, limit)
    return { path: real, folder: false }
  }
  if (!info.isDirectory())
    throw new Error(`Output ${path} must be a file or a folder`)
  tooLarge(path, await folderSize(path, real, real), limit)
  return { path: real, folder: true }
}

/** Copies a checked output to `outputs/<random id>/`, keeping a file's name, and returns the stored path. */
export async function retainOutput(
  home: string,
  path: string,
): Promise<string> {
  const output = await checkOutput(home, path)
  const root = await realpath(home)
  await mkdir(join(root, 'outputs'), { recursive: true })
  if ((await realpath(join(root, 'outputs'))) !== join(root, 'outputs'))
    throw new Error('Output storage must not contain links')
  const destination = join(root, 'outputs', randomUUID())
  try {
    await mkdir(destination)
    if (output.folder) {
      await copyFolder(output.path, destination)
      return destination
    }
    const file = join(destination, basename(output.path))
    await copyFile(output.path, file, constants.COPYFILE_EXCL)
    return file
  } catch (error) {
    await rm(destination, { recursive: true, force: true })
    throw error
  }
}

/** Removes a retained output's whole folder. */
export async function removeOutput(path: string) {
  const match = RETAINED.exec(path)
  if (!match) throw new Error(`Not a retained output: ${path}`)
  await rm(match[2] ? resolve(path, '..') : path, {
    recursive: true,
    force: true,
  })
}

/** The browser address of a retained output: its folder, or the file inside it. */
export function outputUrl(path: string): string | null {
  const match = RETAINED.exec(path)
  if (!match) return null
  return `/files/${match[1]}/${match[2] ? encodeURIComponent(match[2]) : ''}`
}

export function isRetainedOutput(path: string) {
  return RETAINED.test(path)
}

/** A retained output's media type; a folder is `inode/directory`. */
export function retainedOutputType(path: string): string {
  const file = RETAINED.exec(path)?.[2]
  return file === undefined ? 'inode/directory' : fileType(file)
}

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.txt': 'text/plain',
  // Browsers download text/markdown; plain text shows it.
  '.md': 'text/plain',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.wasm': 'application/wasm',
}

/** Media type by extension; outputs are served sandboxed, so their content is not sniffed. */
export function fileType(name: string): string {
  return TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

async function folderSize(
  label: string,
  root: string,
  folder: string,
): Promise<number> {
  let size = 0
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) size += await folderSize(label, root, path)
    else if (entry.isFile()) size += (await lstat(path)).size
    else
      throw new Error(
        `Output ${label} contains ${relative(root, path)}, which is ${entry.isSymbolicLink() ? 'a link' : 'not a file or folder'}; publish only real files`,
      )
  }
  return size
}

async function copyFolder(from: string, to: string) {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    // Re-check each entry while copying so nothing swapped in after the check is followed.
    const info = await lstat(source)
    if (info.isDirectory()) {
      await mkdir(target)
      await copyFolder(source, target)
    } else if (info.isFile())
      await copyFile(source, target, constants.COPYFILE_EXCL)
    else throw new Error(`Output changed while copying: ${source}`)
  }
}

function tooLarge(path: string, size: number, limit: number) {
  if (size > limit)
    throw new Error(
      `Output ${path} is ${size} bytes; the limit is ${limit} bytes (${Math.floor(limit / 1024 / 1024)} MB). Publish built files only, not dependencies or caches.`,
    )
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
