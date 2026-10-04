import { access, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Repository, Ticket } from '../domain/records.ts'
import { run } from '../executors/process.ts'

export class Workspaces {
  readonly home: string
  private readonly queues = new Map<number, Promise<unknown>>()
  constructor(home: string) {
    this.home = resolve(home)
  }
  cache(repository: Repository) {
    return join(this.home, 'repositories', String(repository.id), 'repo')
  }
  path(ticket: Ticket) {
    return join(this.home, 'worktrees', String(ticket.id), 'repo')
  }
  private async serial<T>(id: number, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(work)
    this.queues.set(id, next)
    try {
      return await next
    } finally {
      if (this.queues.get(id) === next) this.queues.delete(id)
    }
  }
  async prepareRepository(
    repository: Repository,
    signal: AbortSignal,
  ): Promise<void> {
    await this.serial(repository.id, async () => {
      const root = join(this.home, 'repositories', String(repository.id))
      await mkdir(root, { recursive: true })
      if (
        (await exists(join(root, 'repo'))) &&
        !(await exists(join(root, 'owner.json')))
      )
        throw new Error(`Refusing to adopt unowned workspace ${root}`)
      await this.ownership(join(root, 'owner.json'), {
        repository: repository.id,
        url: repository.cloneUrl,
      })
      const path = this.cache(repository)
      if (!(await exists(path))) {
        await run('git', ['clone', '--', repository.cloneUrl, path], { signal })
      }
      const origin = await run('git', ['remote', 'get-url', 'origin'], {
        cwd: path,
        signal,
      })
      if (origin !== repository.cloneUrl)
        throw new Error(`Repository cache origin changed: ${path}`)
    })
  }
  async prepare(
    ticket: Ticket,
    repository: Repository,
    signal: AbortSignal,
  ): Promise<string> {
    await this.prepareRepository(repository, signal)
    return this.serial(repository.id, async () => {
      const root = join(this.home, 'worktrees', String(ticket.id))
      const path = this.path(ticket)
      await mkdir(root, { recursive: true })
      if (
        (await exists(join(root, 'repo'))) &&
        !(await exists(join(root, 'owner.json')))
      )
        throw new Error(`Refusing to adopt unowned workspace ${root}`)
      await this.ownership(join(root, 'owner.json'), {
        ticket: ticket.id,
        repository: repository.id,
        branch: ticket.branch,
      })
      if (!(await exists(path))) {
        await run('git', ['fetch', 'origin'], {
          cwd: this.cache(repository),
          signal,
        })
        const branches = await run('git', ['branch', '--list', ticket.branch], {
          cwd: this.cache(repository),
          signal,
        })
        await run(
          'git',
          [
            'worktree',
            'add',
            ...(branches ? [] : ['-b', ticket.branch]),
            path,
            branches ? ticket.branch : `origin/${repository.defaultBranch}`,
          ],
          { cwd: this.cache(repository), signal },
        )
      }
      const branch = await run('git', ['branch', '--show-current'], {
        cwd: path,
        signal,
      })
      if (branch !== ticket.branch)
        throw new Error(`Ticket worktree branch changed: ${path}`)
      return path
    })
  }
  async cleanup(
    ticket: Ticket,
    repository: Repository,
    signal: AbortSignal,
  ): Promise<void> {
    if (ticket.status !== 'done' && ticket.status !== 'cancelled') return
    await this.serial(repository.id, async () => {
      const root = join(this.home, 'worktrees', String(ticket.id))
      const path = this.path(ticket)
      if (!(await exists(path))) return
      const owner = JSON.parse(await readFile(join(root, 'owner.json'), 'utf8'))
      if (
        owner.ticket !== ticket.id ||
        owner.repository !== repository.id ||
        owner.branch !== ticket.branch
      )
        throw new Error(`Refusing to remove unowned worktree ${path}`)
      if (
        await run(
          'git',
          ['status', '--porcelain', '--untracked-files=all', '--ignored'],
          { cwd: path, signal },
        )
      )
        return
      // Git itself refuses locked, dirty or unregistered worktrees. Keep the branch and evidence.
      await run('git', ['worktree', 'remove', path], {
        cwd: this.cache(repository),
        signal,
      })
      await rm(join(root, 'owner.json'))
    })
  }
  private async ownership(path: string, owner: object) {
    try {
      await writeFile(path, JSON.stringify(owner), { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if ((await readFile(path, 'utf8')) !== JSON.stringify(owner))
        throw new Error(`Workspace ownership mismatch: ${path}`, {
          cause: error,
        })
    }
  }
}
async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
