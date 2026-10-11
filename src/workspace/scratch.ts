import { access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { run } from '../executors/process.ts'

/** Creates `<home>/scratch.git`, a bare repository whose `main` holds one empty commit; an existing one is reused. */
export async function createScratchGit(home: string): Promise<string> {
  const path = join(resolve(home), 'scratch.git')
  const signal = AbortSignal.timeout(30_000)
  const git = (args: string[]) => run('git', args, { cwd: path, signal })
  try {
    await access(join(path, 'HEAD'))
    await git(['rev-parse', '--verify', 'refs/heads/main'])
    return path
  } catch {}
  await run('git', ['init', '--bare', '--initial-branch=main', path], {
    signal,
  })
  const tree = await git(['hash-object', '-t', 'tree', '-w', '/dev/null'])
  const commit = await git([
    '-c',
    'user.name=Kipster Factory',
    '-c',
    'user.email=kipster@localhost',
    'commit-tree',
    tree,
    '-m',
    'Start the scratch repository',
  ])
  await git(['update-ref', 'refs/heads/main', commit])
  return path
}
