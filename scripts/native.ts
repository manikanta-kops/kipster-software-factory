import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { factoryVersion } from '../src/config.ts'
import { SERVICE_APP_NAME } from '../src/service-app.ts'

const sources = fileURLToPath(new URL('../native/', import.meta.url))

export function buildServiceApp(options: {
  out: string
  arch?: string
  identity?: string
  keychain?: string
}): string {
  if (process.platform !== 'darwin')
    throw new Error('Build the service app on macOS.')
  const arch = options.arch ?? process.arch
  if (arch !== 'arm64' && arch !== 'x64')
    throw new Error('Unsupported Mac architecture.')
  const app = join(options.out, SERVICE_APP_NAME)
  const contents = join(app, 'Contents')
  mkdirSync(join(contents, 'MacOS'), { recursive: true })
  const sdk = execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], {
    encoding: 'utf8',
  }).trim()
  execFileSync(
    'xcrun',
    [
      'clang',
      '-arch',
      arch === 'x64' ? 'x86_64' : arch,
      '-isysroot',
      sdk,
      '-mmacosx-version-min=13.0',
      '-fobjc-arc',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-framework',
      'Foundation',
      '-o',
      join(contents, 'MacOS', 'Factory'),
      join(sources, 'Factory.m'),
    ],
    { stdio: 'inherit' },
  )
  writeFileSync(
    join(contents, 'Info.plist'),
    readFileSync(join(sources, 'Info.plist'), 'utf8').replaceAll(
      '@VERSION@',
      factoryVersion(),
    ),
  )
  const identity = options.identity ?? '-'
  execFileSync(
    'codesign',
    [
      '--force',
      '--sign',
      identity,
      '--options',
      'runtime',
      '--entitlements',
      join(sources, 'entitlements.plist'),
      ...(identity === '-' ? [] : ['--timestamp']),
      ...(options.keychain ? ['--keychain', options.keychain] : []),
      app,
    ],
    { stdio: 'inherit' },
  )
  execFileSync('codesign', ['--verify', '--strict', app], { stdio: 'inherit' })
  return app
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: '.local/native' },
      arch: { type: 'string', default: process.arch },
      identity: { type: 'string', default: '-' },
      keychain: { type: 'string' },
    },
  })
  console.log(
    buildServiceApp({
      out: resolve(values.out),
      arch: values.arch,
      identity: values.identity,
      ...(values.keychain ? { keychain: values.keychain } : {}),
    }),
  )
}
