import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  rmdir,
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
  skipGit = false,
): Promise<void> {
  if (skipGit && relative === '.git') return
  const path = join(root, relative)
  const info = await lstat(path)
  await visit(path, relative)
  if (info.isDirectory() && !info.isSymbolicLink())
    for (const name of (await readdir(path)).sort())
      await entries(root, visit, join(relative, name), skipGit)
}

async function permissions(
  path: string,
  writable: boolean,
  signal: AbortSignal,
): Promise<void> {
  await entries(path, async (file) => {
    signal.throwIfAborted()
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
  const visit = async (file: string, relative: string) => {
    const info = await lstat(file)
    const hash = createHash('sha256')
    if (info.isSymbolicLink()) hash.update(await readlink(file))
    else if (info.isFile())
      for await (const chunk of createReadStream(file)) hash.update(chunk)
    files.set(relative, `${info.mode}:${hash.digest('hex')}`)
  }
  await entries(root, visit, '', true)
  const metadata = await present(join(root, '.git'))
  if (metadata) await visit(join(root, '.git'), '.git')
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) return files
  // Observe HEAD, refs and checkout configuration, never scan the shared object database or Git packs.
  for (const relative of [
    '.git/HEAD',
    '.git/refs',
    '.git/packed-refs',
    '.git/config',
    '.git/objects/info/alternates',
  ])
    if (await present(join(root, relative)))
      await entries(root, visit, relative)
  return files
}

async function present(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
}

export async function removeDependencies(
  workspaces: Workspaces,
  ticket: Ticket,
  signal: AbortSignal,
): Promise<void> {
  const parent = join(workspaces.home, 'dependencies')
  const root = join(parent, String(ticket.id))
  if (!(await present(root))) return
  for (const directory of [parent, root])
    if ((await lstat(directory)).isSymbolicLink())
      throw new Error('Refusing to clean a symlinked dependency directory')
  for (const name of await readdir(root)) {
    signal.throwIfAborted()
    const directory = join(root, name)
    if (!/^\d+$/.test(name) || (await lstat(directory)).isSymbolicLink())
      throw new Error('Refusing to clean an unowned dependency directory')
    if (
      (await readdir(directory)).some(
        (file) => !['owner.json', 'repo'].includes(file),
      )
    )
      throw new Error(
        'Unknown state beside dependency checkout; preserved for inspection',
      )
    const ownerFile = join(directory, 'owner.json')
    if ((await lstat(ownerFile)).isSymbolicLink())
      throw new Error('Refusing to clean a symlinked dependency owner')
    const owner = JSON.parse(await readFile(ownerFile, 'utf8'))
    if (owner.ticket !== ticket.id || owner.repository !== Number(name))
      throw new Error('Dependency ownership mismatch during cleanup')
    const cacheOwner = join(workspaces.home, 'repositories', name, 'owner.json')
    if (
      (await readFile(cacheOwner, 'utf8')) !==
      JSON.stringify({ repository: owner.repository, url: owner.url })
    )
      throw new Error('Dependency cache ownership mismatch during cleanup')
    const path = join(directory, 'repo')
    const info = await present(path)
    if (info && !info.isSymbolicLink()) await permissions(path, true, signal)
    await rm(path, { recursive: true, force: true })
    await workspaces.unpinDependency(ticket, owner.repository, signal)
    await rm(ownerFile)
    await rmdir(directory)
  }
  await rmdir(root)
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
      if ((await lstat(join(root, 'owner.json'))).isSymbolicLink())
        throw new Error('Dependency owner was replaced with a symlink', {
          cause: error,
        })
      if ((await readFile(join(root, 'owner.json'), 'utf8')) !== owner)
        throw new Error('Dependency ownership mismatch', { cause: error })
    }
    if (existing?.isSymbolicLink())
      throw new Error('Dependency checkout was replaced with a symlink')
    const { cache, branch, commit } = await workspaces.pinDependency(
      ticket,
      repository,
      signal,
    )
    const clone = async () => {
      signal.throwIfAborted()
      await run('git', ['init', '--template=', '-b', branch, '--', path], {
        signal,
      })
      await writeFile(
        join(path, '.git/objects/info/alternates'),
        `${join(cache, '.git/objects')}\n`,
      )
      await run('git', ['update-ref', `refs/heads/${branch}`, commit], {
        cwd: path,
        signal,
      })
      await run('git', ['checkout', '--detach', commit], {
        cwd: path,
        signal,
      })
      await permissions(path, false, signal)
    }
    // Recreate from the fetched cache so a factory crash cannot preserve agent edits or Git configuration.
    if (existing) {
      await permissions(path, true, signal)
      await rm(path, { recursive: true })
    }
    await clone()
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
        signal.throwIfAborted()
        if (info && !info.isSymbolicLink())
          await permissions(path, true, signal)
        await rm(path, { recursive: true, force: true })
        await clone()
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
