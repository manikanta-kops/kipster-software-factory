import { FactoryError } from '../domain/errors.ts'
import type { Repository, RepositoryStatus } from '../domain/records.ts'
import { type Database, type Queryable, transaction } from './database.ts'
import { recordEvents } from './events.ts'

export interface NewRepository {
  /** `owner/name` */
  readonly slug: string
  /** Default: `https://github.com/<slug>.git` */
  readonly cloneUrl?: string
  /** Default: `main`; the engine may correct it when it marks the repository ready. */
  readonly defaultBranch?: string
}

interface RepositoryRow {
  id: number
  slug: string
  clone_url: string
  default_branch: string
  status: RepositoryStatus
  last_error: string | null
  capabilities: string[]
  created_at: Date
  updated_at: Date
}

function toRepository(row: RepositoryRow): Repository {
  return {
    id: row.id,
    slug: row.slug,
    cloneUrl: row.clone_url,
    defaultBranch: row.default_branch,
    status: row.status,
    lastError: row.last_error,
    capabilities: row.capabilities,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

/** Registers a repository as pending; the engine clones it and marks it ready or failed. */
export async function createRepository(
  database: Database,
  input: NewRepository,
): Promise<Repository> {
  return transaction(database, async (connection) => {
    const { rows } = await connection.query<RepositoryRow>(
      `INSERT INTO repositories (slug, clone_url, default_branch)
       VALUES ($1, $2, $3)
       ON CONFLICT ((lower(slug))) DO NOTHING
       RETURNING *`,
      [
        input.slug,
        input.cloneUrl ?? `https://github.com/${input.slug}.git`,
        input.defaultBranch ?? 'main',
      ],
    )
    const row = rows[0]
    if (!row) {
      throw new FactoryError(
        'conflict',
        `Repository ${input.slug} is already registered`,
      )
    }
    await recordEvents(connection, [
      {
        ticketId: null,
        kind: 'repository.created',
        data: { repositoryId: row.id, slug: row.slug },
      },
    ])
    return toRepository(row)
  })
}

export async function listRepositories(
  database: Queryable,
  filter: { readonly status?: RepositoryStatus } = {},
): Promise<Repository[]> {
  const { rows } = await database.query<RepositoryRow>(
    `SELECT * FROM repositories
     WHERE $1::text IS NULL OR status = $1
     ORDER BY lower(slug)`,
    [filter.status ?? null],
  )
  return rows.map(toRepository)
}

/** Finds a repository by `owner/name`, ignoring case. */
export async function getRepository(
  database: Queryable,
  slug: string,
): Promise<Repository | null> {
  const { rows } = await database.query<RepositoryRow>(
    'SELECT * FROM repositories WHERE lower(slug) = lower($1)',
    [slug],
  )
  return rows[0] ? toRepository(rows[0]) : null
}

export async function markRepositoryReady(
  database: Database,
  id: number,
  update: {
    readonly defaultBranch?: string
    readonly capabilities?: readonly string[]
  } = {},
): Promise<Repository> {
  return transaction(database, async (connection) => {
    const { rows } = await connection.query<RepositoryRow>(
      `UPDATE repositories
       SET status = 'ready', last_error = NULL, updated_at = now(),
           default_branch = coalesce($2, default_branch),
           capabilities = coalesce($3, capabilities)
       WHERE id = $1
       RETURNING *`,
      [id, update.defaultBranch ?? null, update.capabilities ?? null],
    )
    const row = found(rows[0], id)
    await recordEvents(connection, [
      {
        ticketId: null,
        kind: 'repository.ready',
        data: { repositoryId: id, slug: row.slug },
      },
    ])
    return toRepository(row)
  })
}

export async function markRepositoryFailed(
  database: Database,
  id: number,
  error: string,
): Promise<Repository> {
  return transaction(database, async (connection) => {
    const { rows } = await connection.query<RepositoryRow>(
      `UPDATE repositories
       SET status = 'failed', last_error = $2, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, error],
    )
    const row = found(rows[0], id)
    await recordEvents(connection, [
      {
        ticketId: null,
        kind: 'repository.failed',
        data: { repositoryId: id, slug: row.slug, error },
      },
    ])
    return toRepository(row)
  })
}

export async function getRepositoryById(
  database: Queryable,
  id: number,
): Promise<Repository | null> {
  const { rows } = await database.query<RepositoryRow>(
    'SELECT * FROM repositories WHERE id = $1',
    [id],
  )
  return rows[0] ? toRepository(rows[0]) : null
}

function found(row: RepositoryRow | undefined, id: number): RepositoryRow {
  if (!row) throw new FactoryError('not-found', `No repository with id ${id}`)
  return row
}
