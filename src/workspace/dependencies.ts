import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import type { Repository, Ticket } from '../domain/records.ts'
import { run } from '../executors/process.ts'
import type { Workspaces } from './workspaces.ts'

export class DependencyChangedError extends Error {}

export interface DependencyCheckout {
  readonly repository: string
  readonly path: string
  readonly commit: string
}

async function entries(
  root: string,
  visit: (path: string, relative: string) => Promise<void>,
  relative = '',
): Promise<void> {
  const path = join(root, relative)
  const info = await lstat(path)
  await visit(path, relative)
  if (info.isDirectory() && !info.isSymbolicLink())
    for (const name of (await readdir(path)).sort())
      await entries(root, visit, join(relative, name))
}

async function permissions(path: string, writable: boolean): Promise<void> {
  await entries(path, async (file) => {
    const info = await lstat(file)
    if (info.isSymbolicLink()) return
    await chmod(
      file,
      info.isDirectory()
        ? writable
          ? 0o755
          : 0o555
        : info.mode & 0o111
          ? writable
            ? 0o755
            : 0o555
          : writable
            ? 0o644
            : 0o444,
    )
  })
}

async function snapshot(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  await entries(root, async (file, relative) => {
    const info = await lstat(file)
    const content = info.isSymbolicLink()
      ? await readlink(file)
      : info.isFile()
        ? await readFile(file).catch(() => Buffer.from('unreadable'))
        : 'directory'
    files.set(
      relative,
      `${info.mode}:${createHash('sha256').update(content).digest('hex')}`,
    )
  })
  return files
}

export async function prepareDependencies(
  workspaces: Workspaces,
  ticket: Ticket,
  repositories: readonly Repository[],
  signal: AbortSignal,
): Promise<{
  checkouts: readonly DependencyCheckout[]
  verify(): Promise<void>
}> {
  const prepared: {
    checkout: DependencyCheckout
    before: Map<string, string>
    restore(): Promise<void>
  }[] = []
  for (const repository of repositories) {
    signal.throwIfAborted()
    const branch = await workspaces.prepareRepository(repository, signal)
    const cache = workspaces.cache(repository)
    const commit = await run('git', ['rev-parse', `origin/${branch}`], {
      cwd: cache,
      signal,
    })
    const root = join(
      workspaces.home,
      'dependencies',
      String(ticket.id),
      String(repository.id),
    )
    const path = join(root, 'repo')
    const directories = [
      join(workspaces.home, 'dependencies'),
      join(workspaces.home, 'dependencies', String(ticket.id)),
      root,
    ]
    for (const directory of directories) {
      await mkdir(directory, { recursive: true })
      if ((await lstat(directory)).isSymbolicLink())
        throw new Error('Dependency directory was replaced with a symlink')
    }
    const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (existing && !(await lstat(join(root, 'owner.json')).catch(() => null)))
      throw new Error('Refusing to adopt an unowned dependency checkout')
    const owner = JSON.stringify({
      ticket: ticket.id,
      repository: repository.id,
      url: repository.cloneUrl,
    })
    try {
      await writeFile(join(root, 'owner.json'), owner, { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if ((await readFile(join(root, 'owner.json'), 'utf8')) !== owner)
        throw new Error('Dependency ownership mismatch', { cause: error })
    }
    if (existing?.isSymbolicLink())
      throw new Error('Dependency checkout was replaced with a symlink')
    const clone = async (lifetime: AbortSignal) => {
      await run(
        'git',
        ['clone', '--no-local', '--no-checkout', '--', cache, path],
        { signal: lifetime },
      )
      await run('git', ['remote', 'remove', 'origin'], {
        cwd: path,
        signal: lifetime,
      })
      await run(
        'git',
        ['fetch', '--no-tags', '--', cache, `refs/remotes/origin/${branch}`],
        { cwd: path, signal: lifetime },
      )
      await run('git', ['checkout', '--detach', commit], {
        cwd: path,
        signal: lifetime,
      })
      await permissions(path, false)
    }
    // Recreate from the fetched cache so a factory crash cannot preserve agent edits or Git configuration.
    if (existing) {
      await permissions(path, true)
      await rm(path, { recursive: true })
    }
    await clone(signal)
    const checkout = { repository: repository.slug, path, commit }
    prepared.push({
      checkout,
      before: await snapshot(path),
      restore: async () => {
        for (const directory of directories)
          if ((await lstat(directory)).isSymbolicLink())
            throw new Error(
              'Refusing to restore through a symlinked dependency directory',
            )
        const ownerFile = join(root, 'owner.json')
        if (
          (await lstat(ownerFile)).isSymbolicLink() ||
          (await readFile(ownerFile, 'utf8')) !== owner
        )
          throw new Error(
            'Dependency ownership changed; preserved for inspection',
          )
        const info = await lstat(path).catch(() => null)
        if (info && !info.isSymbolicLink()) await permissions(path, true)
        await rm(path, { recursive: true, force: true })
        await clone(AbortSignal.timeout(30_000))
      },
    })
  }
  return {
    checkouts: prepared.map((item) => item.checkout),
    async verify() {
      const changes: string[] = []
      const failures: string[] = []
      for (const item of prepared) {
        let after: Map<string, string>
        try {
          after = await snapshot(item.checkout.path)
        } catch {
          after = new Map()
        }
        const changed = [
          ...new Set([...item.before.keys(), ...after.keys()]),
        ].filter((file) => item.before.get(file) !== after.get(file))
        if (changed.length) {
          changes.push(
            `${item.checkout.repository}: ${changed.map((file) => file || '(checkout)').join(', ')}`,
          )
          try {
            await item.restore()
          } catch (error) {
            failures.push(`${item.checkout.repository}: ${String(error)}`)
          }
        }
      }
      if (changes.length)
        throw new DependencyChangedError(
          `Agent changed read-only dependencies; ${failures.length ? `restoration failed (${failures.join('; ')})` : 'restored checkouts'}. Changed files: ${changes.join('; ')}`,
        )
    },
  }
}
