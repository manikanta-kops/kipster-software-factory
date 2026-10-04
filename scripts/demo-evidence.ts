// Synthetic media for UI development, generated under factory home, never real proof.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

function crc32(bytes: Buffer) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(name: string, bytes: Buffer) {
  const type = Buffer.from(name)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(bytes.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([type, bytes])))
  return Buffer.concat([length, type, bytes, crc])
}
function png() {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(320, 0)
  header.writeUInt32BE(180, 4)
  header[8] = 8
  header[9] = 2
  const rows = Buffer.alloc(180 * (1 + 320 * 3))
  for (let y = 0; y < 180; y++)
    for (let x = 0; x < 320; x++) {
      const index = y * 961 + 1 + x * 3
      const card = x > 24 && x < 296 && y > 24 && y < 156
      rows.set(card ? [56, 108, 80] : [240, 243, 240], index)
    }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
function element(id: string, data: Buffer) {
  const size =
    data.length < 127
      ? Buffer.from([0x80 | data.length])
      : Buffer.from([0x40 | (data.length >> 8), data.length & 255])
  return Buffer.concat([Buffer.from(id, 'hex'), size, data])
}
function webm() {
  const number = (id: string, n: number) => element(id, Buffer.from([n]))
  const header = element(
    '1a45dfa3',
    Buffer.concat([
      number('4286', 1),
      number('42f7', 1),
      number('42f2', 4),
      number('42f3', 8),
      element('4282', Buffer.from('webm')),
      number('4287', 2),
      number('4285', 2),
    ]),
  )
  const duration = Buffer.alloc(8)
  duration.writeDoubleBE(1000)
  const info = element(
    '1549a966',
    Buffer.concat([
      element('2ad7b1', Buffer.from('0f4240', 'hex')),
      element('4489', duration),
      element('4d80', Buffer.from('Kipster demo')),
      element('5741', Buffer.from('Kipster demo')),
    ]),
  )
  const track = element(
    '1654ae6b',
    element(
      'ae',
      Buffer.concat([
        number('d7', 1),
        number('73c5', 1),
        number('83', 1),
        element('86', Buffer.from('V_VP8')),
        element('e0', Buffer.concat([number('b0', 32), number('ba', 32)])),
      ]),
    ),
  )
  // One encoded solid-color VP8 keyframe, wrapped into a generated WebM container.
  const frame = Buffer.from(
    'cAIAnQEqIAAgAABHCIWFiJmEiAICAnTyxmH+AAD++2iXXFzZEUf/TSP/6aR//TSPlNA=',
    'base64',
  )
  const cluster = element(
    '1f43b675',
    Buffer.concat([
      number('e7', 0),
      element('a3', Buffer.concat([Buffer.from([0x81, 0, 0, 0x80]), frame])),
    ]),
  )
  return Buffer.concat([
    header,
    element('18538067', Buffer.concat([info, track, cluster])),
  ])
}
export async function writeDemoEvidence(home: string) {
  const directory = join(home, 'demo-evidence')
  await mkdir(directory, { recursive: true })
  const files = {
    image: join(directory, 'cart.png'),
    video: join(directory, 'cart.webm'),
    log: join(directory, 'verification.log'),
  }
  await writeFile(files.image, png())
  await writeFile(files.video, webm())
  await writeFile(
    files.log,
    'Synthetic demo evidence, not an actual verification run.\nAction: open cart\nObserved: quantity 2; total €24.00\nVerdict: passed at the recorded demo commit.\n',
  )
  return files
}
