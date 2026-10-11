import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { APP_FILES, BUILT_APP_FILES } from '../scripts/bundle-files.ts'

const root = fileURLToPath(new URL('../', import.meta.url))

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

test('the release app ships every repository file the runtime reads', () => {
  const missing: string[] = []
  for (const file of sources(join(root, 'src'))) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/new URL\(\s*[`'"](\.\.?\/[^`'"$]*)/g)) {
      const target = relative(
        root,
        fileURLToPath(new URL(match[1]!, `file://${file}`)),
      )
      // Paths outside the repository, such as the bundled PostgreSQL, are not app files.
      if (target.startsWith('..')) continue
      if (
        ![...APP_FILES, ...BUILT_APP_FILES].some(
          (entry) =>
            target === entry ||
            target.startsWith(`${entry}/`) ||
            `${target}/`.startsWith(`${entry}/`),
        )
      )
        missing.push(`${relative(root, file)} reads ${target}`)
    }
  }
  assert.deepEqual(missing, [])
})

test('copying a nested shipped file creates its folder', () => {
  const app = mkdtempSync(join(tmpdir(), 'ksf-bundle-'))
  try {
    cpSync(join(root, 'docs/kit.md'), join(app, 'docs/kit.md'), {
      recursive: true,
    })
    assert.match(
      readFileSync(join(app, 'docs/kit.md'), 'utf8'),
      /^# Repository kit/,
    )
  } finally {
    rmSync(app, { recursive: true, force: true })
  }
})
