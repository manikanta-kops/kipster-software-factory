// Builds the self-contained macOS release archive that install.sh installs: the app with
// its production dependencies and built web app, Node.js and PostgreSQL. Every download
// is pinned by SHA-256 so a release is reproducible from its commit.
// Usage: node scripts/bundle.ts [--arch arm64|x64] [--out <dir>]
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { factoryVersion } from '../src/config.ts'
import { root } from './dev-database.ts'
import { buildServiceApp } from './native.ts'
import { SERVICE_APP_NAME, verifyServiceApp } from '../src/service-app.ts'

const NODE = '26.10.0'
const POSTGRES = '18.6.0'
const SOURCES = {
  arm64: {
    node: '751fdf7439f115d87ee2a8f3f18c065b6151852068e3e666ac60ac2996f75ac9',
    postgres: {
      artifact: 'embedded-postgres-binaries-darwin-arm64v8',
      sha256:
        '8f6ed6f38195b50a40712ada8b2a12060b6193c1a6977a6eb5cff053bb5a1b89',
    },
    lipo: 'arm64',
  },
  x64: {
    node: 'ebbe9ab9b58ad6bb54390d6e2c862c1afa7d4475fb7e8ae8146acde211bf70df',
    postgres: {
      artifact: 'embedded-postgres-binaries-darwin-amd64',
      sha256:
        '690941008aac9ee360820fde9bb7870a4f3dcac5e9e2f9e45e42333a436ad0f9',
    },
    lipo: 'x86_64',
  },
} as const

const WRAPPER = `#!/bin/sh
# Runs the Kipster Software Factory with the Node.js bundled next to it.
set -e
script=$0
while [ -L "$script" ]; do
  target=$(readlink "$script")
  case $target in
    /*) script=$target ;;
    *) script=$(dirname "$script")/$target ;;
  esac
done
root=$(cd "$(dirname "$script")/.." && pwd -P)
exec "$root/node/bin/node" "$root/app/src/cli.ts" "$@"
`

const { values } = parseArgs({
  options: {
    arch: { type: 'string', default: process.arch },
    out: { type: 'string', default: join(root, 'release') },
    'service-app': { type: 'string' },
    'require-signed-service': { type: 'boolean' },
    'signing-team': { type: 'string' },
  },
})
const arch = values.arch as keyof typeof SOURCES
if (process.platform !== 'darwin') throw new Error('Bundles build on macOS.')
if (!(arch in SOURCES)) throw new Error('--arch must be arm64 or x64')
const source = SOURCES[arch]
const out = resolve(values.out)
const cache = join(root, '.local', 'bundle-cache')
const name = `kf-darwin-${arch}`

function sh(program: string, args: string[], cwd?: string): string {
  const result = spawnSync(program, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0)
    throw new Error(
      `${program} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`,
    )
  return result.stdout.trim()
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

async function download(url: string, expected: string): Promise<string> {
  mkdirSync(cache, { recursive: true })
  const file = join(cache, basename(new URL(url).pathname))
  if (!existsSync(file) || sha256(file) !== expected) {
    console.log(`Downloading ${url}`)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
    writeFileSync(file, Buffer.from(await response.arrayBuffer()))
  }
  const actual = sha256(file)
  if (actual !== expected)
    throw new Error(`${url}: SHA-256 ${actual} does not match ${expected}`)
  return file
}

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) return []
    return entry.isDirectory() ? files(path) : [path]
  })
}

/** Keeps one architecture of universal binaries; each slice keeps its own signature. */
function thin(directory: string) {
  for (const file of files(directory)) {
    const archs = spawnSync('lipo', ['-archs', file], { encoding: 'utf8' })
    if (archs.status !== 0 || !archs.stdout.trim().includes(' ')) continue
    sh('lipo', ['-thin', source.lipo, '-output', `${file}.thin`, file])
    chmodSync(`${file}.thin`, statSync(file).mode)
    renameSync(`${file}.thin`, file)
  }
}

/** The archive stores library aliases as copies; restore them as symbolic links. */
function linkDuplicates(directory: string) {
  const byContent = new Map<string, string[]>()
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const hash = sha256(join(directory, entry.name))
    byContent.set(hash, [...(byContent.get(hash) ?? []), entry.name])
  }
  for (const names of byContent.values()) {
    if (names.length < 2) continue
    const [target, ...aliases] = names.toSorted((a, b) => b.length - a.length)
    for (const alias of aliases) {
      unlinkSync(join(directory, alias))
      symlinkSync(target!, join(directory, alias))
    }
  }
}

const staging = mkdtempSync(join(tmpdir(), 'kf-bundle-'))
try {
  const bundle = join(staging, name)
  mkdirSync(join(bundle, 'bin'), { recursive: true })

  const nodeArchive = await download(
    `https://nodejs.org/dist/v${NODE}/node-v${NODE}-darwin-${arch}.tar.gz`,
    source.node,
  )
  sh('tar', ['-xzf', nodeArchive, '-C', staging])
  const nodeRoot = join(staging, `node-v${NODE}-darwin-${arch}`)
  mkdirSync(join(bundle, 'node', 'bin'), { recursive: true })
  renameSync(join(nodeRoot, 'bin', 'node'), join(bundle, 'node', 'bin', 'node'))
  renameSync(join(nodeRoot, 'LICENSE'), join(bundle, 'node', 'LICENSE'))

  const postgresJar = await download(
    `https://repo1.maven.org/maven2/io/zonky/test/postgres/${source.postgres.artifact}/${POSTGRES}/${source.postgres.artifact}-${POSTGRES}.jar`,
    source.postgres.sha256,
  )
  const unpacked = join(staging, 'postgres-jar')
  sh('unzip', ['-q', postgresJar, '-d', unpacked])
  const txz = readdirSync(unpacked).find((file) => file.endsWith('.txz'))
  if (!txz) throw new Error('PostgreSQL archive is missing from the jar')
  mkdirSync(join(bundle, 'postgres'))
  sh('tar', ['-xJf', join(unpacked, txz), '-C', join(bundle, 'postgres')])
  thin(join(bundle, 'postgres'))
  linkDuplicates(join(bundle, 'postgres', 'lib'))

  console.log('Building the web app')
  sh(
    process.execPath,
    [join(root, 'node_modules/vite/bin/vite.js'), 'build'],
    root,
  )
  const app = join(bundle, 'app')
  for (const entry of [
    'src',
    'workflows',
    'package.json',
    'package-lock.json',
    'LICENSE',
    'README.md',
  ])
    cpSync(join(root, entry), join(app, entry), { recursive: true })
  cpSync(join(root, 'dist', 'web'), join(app, 'dist', 'web'), {
    recursive: true,
  })
  console.log('Installing production dependencies')
  sh(
    'npm',
    [
      'ci',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--os=darwin',
      `--cpu=${arch}`,
    ],
    app,
  )

  const serviceApp = values['service-app']
    ? resolve(values['service-app'])
    : buildServiceApp({ out: join(staging, 'native'), arch })
  verifyServiceApp(serviceApp)
  sh('lipo', [
    join(serviceApp, 'Contents', 'MacOS', 'Factory'),
    '-verify_arch',
    source.lipo,
  ])
  if (values['require-signed-service']) {
    const team = values['signing-team']
    if (!team || !/^[A-Z0-9]{10}$/.test(team))
      throw new Error(
        '--signing-team must name the expected 10-character Apple team for a public release.',
      )
    sh('codesign', [
      '--verify',
      '--strict',
      '-R',
      `=identifier "app.kipster.factory" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "${team}"`,
      serviceApp,
    ])
    sh('xcrun', ['stapler', 'validate', serviceApp])
  }
  sh('ditto', [serviceApp, join(app, 'native', SERVICE_APP_NAME)])
  verifyServiceApp(join(app, 'native', SERVICE_APP_NAME))

  writeFileSync(join(bundle, 'bin', 'kf'), WRAPPER, { mode: 0o755 })
  writeFileSync(join(bundle, 'VERSION'), `${factoryVersion()}\n`)

  if (arch === process.arch) {
    const kf = join(bundle, 'bin', 'kf')
    const reported = sh(kf, ['--version'])
    if (reported !== factoryVersion())
      throw new Error(`Bundled kf reports ${reported}`)
    sh(join(bundle, 'postgres', 'bin', 'postgres'), ['--version'])
  }

  mkdirSync(out, { recursive: true })
  const archive = `${name}.tar.gz`
  sh('tar', ['-czf', join(out, archive), '-C', staging, name])
  cpSync(join(root, 'install.sh'), join(out, 'install.sh'))
  const sums = readdirSync(out)
    .filter((file) => file !== 'SHA256SUMS')
    .toSorted()
    .map((file) => `${sha256(join(out, file))}  ${file}`)
  writeFileSync(join(out, 'SHA256SUMS'), `${sums.join('\n')}\n`)
  console.log(
    `${join(out, archive)} (${(statSync(join(out, archive)).size / 1e6).toFixed(0)} MB)`,
  )
} finally {
  rmSync(staging, { recursive: true, force: true })
}
