import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { signInToGitHubWithCli } from '../src/github/credentials.ts'

const exec = promisify(execFile)

async function sandbox(t: { after: (fn: () => Promise<void>) => void }) {
  const home = await mkdtemp(join(tmpdir(), 'ksf-gh-credentials-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  // A fake gh that answers git's credential protocol like `gh auth git-credential`.
  await writeFile(
    join(home, 'gh'),
    '#!/bin/sh\n[ "$1 $2 $3" = "auth git-credential get" ] || exit 1\ncat >/dev/null\nprintf "username=x-access-token\\npassword=from-gh\\n"\n',
  )
  await chmod(join(home, 'gh'), 0o755)
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: `${home}:${process.env['PATH']}`,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  }
  return { home, env }
}

async function fill(env: NodeJS.ProcessEnv) {
  const child = execFile('git', ['credential', 'fill'], { env })
  child.stdin!.end('protocol=https\nhost=github.com\n\n')
  let out = ''
  child.stdout!.on('data', (chunk) => (out += chunk))
  await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  return out
}

test('factory git commands sign in to GitHub with the gh login', async (t) => {
  const { env } = await sandbox(t)
  signInToGitHubWithCli(env)
  assert.match(await fill(env), /password=from-gh/)
})

test('an existing git login is still tried first, and the helper is added once', async (t) => {
  const { home, env } = await sandbox(t)
  await exec('git', ['config', '--global', 'credential.helper', 'store'], {
    env,
  })
  await writeFile(
    join(home, '.git-credentials'),
    'https://saved:from-store@github.com\n',
  )
  signInToGitHubWithCli(env)
  signInToGitHubWithCli(env)
  assert.equal(env['GIT_CONFIG_COUNT'], '1')
  assert.match(await fill(env), /password=from-store/)
})

test('existing git environment config is kept', async () => {
  const env: NodeJS.ProcessEnv = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.autocrlf',
    GIT_CONFIG_VALUE_0: 'false',
  }
  signInToGitHubWithCli(env)
  assert.equal(env['GIT_CONFIG_COUNT'], '2')
  assert.equal(env['GIT_CONFIG_KEY_0'], 'core.autocrlf')
  assert.equal(env['GIT_CONFIG_KEY_1'], 'credential.https://github.com.helper')
  assert.equal(env['GIT_CONFIG_VALUE_1'], '!gh auth git-credential')
})
