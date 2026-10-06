import { open } from 'node:fs/promises'
import { extname } from 'node:path'

/** Detect binary evidence by signature; extensions only distinguish inert text formats. */
export async function detectMediaType(path: string): Promise<string> {
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(4096)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    const bytes = buffer.subarray(0, bytesRead)
    if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
      return 'image/png'
    if (bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')))
      return 'image/jpeg'
    if (/^GIF8[79]a/.test(bytes.toString('ascii', 0, 6))) return 'image/gif'
    if (
      bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WEBP'
    )
      return 'image/webp'
    if (
      bytes.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex')) &&
      bytes.includes(Buffer.from('webm'))
    )
      return 'video/webm'
    if (bytes.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4'
    if (bytes.includes(0)) return 'application/octet-stream'
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true })
    } catch {
      return 'application/octet-stream'
    }
    if (/\.(md|markdown)$/i.test(extname(path))) return 'text/markdown'
    if (extname(path).toLowerCase() === '.json') return 'application/json'
    return 'text/plain'
  } finally {
    await file.close()
  }
}
