import { useState, type CSSProperties } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  CreateRepositoryRequest,
  RepositoriesResponse,
} from '../../../src/api/contract.ts'
import { api } from '../api.ts'
import { ErrorMessage, Status } from '../components/Shared.tsx'
import { repositoriesQuery } from '../queries.ts'
import { RepositoryDot } from '../components/Filters.tsx'

const KIT_WORDS = {
  valid: 'Kit ready, so every workflow can run here',
  invalid: 'Kit needs a fix. Quick changes still run.',
  missing: 'No kit yet, so only quick changes run here',
} as const

function repositoryInput(input: string): CreateRepositoryRequest {
  const value = input.trim()
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) return { slug: value }
  const scp = /^git@[^:]+:([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(value)
  if (scp?.[1]) return { slug: scp[1], cloneUrl: value }
  try {
    const parsed = new URL(value)
    const slug = parsed.pathname
      .replace(/^\//, '')
      .replace(/\/$/, '')
      .replace(/\.git$/, '')
    if (
      ['https:', 'http:', 'ssh:'].includes(parsed.protocol) &&
      /^[\w.-]+\/[\w.-]+$/.test(slug)
    )
      return { slug, cloneUrl: value }
  } catch {
    /* Fall through to the input hint. */
  }
  throw new Error(
    'Enter owner/name or a clone URL such as https://github.com/owner/name.git.',
  )
}
export function Repositories() {
  const query = useQuery(repositoriesQuery)
  const client = useQueryClient()
  const [input, setInput] = useState('')
  const add = useMutation({
    mutationFn: (value: string) => api.createRepository(repositoryInput(value)),
    onSuccess: () => {
      setInput('')
      void client.invalidateQueries({ queryKey: ['repositories'] })
    },
  })
  const retry = useMutation({
    mutationFn: (id: number) => api.retryRepository(id),
    onSettled: () => client.invalidateQueries({ queryKey: ['repositories'] }),
  })
  const policy = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      api.setAutoMerge(id, { enabled }),
    onMutate: ({ id, enabled }) => {
      void client.cancelQueries({ queryKey: ['repositories'] })
      const previous = client.getQueryData<RepositoriesResponse>([
        'repositories',
      ])
      client.setQueryData<RepositoriesResponse>(['repositories'], (data) =>
        data
          ? {
              repositories: data.repositories.map((repository) =>
                repository.id === id
                  ? { ...repository, autoMerge: enabled }
                  : repository,
              ),
            }
          : data,
      )
      return previous
    },
    onError: (_error, _input, previous) => {
      if (previous) client.setQueryData(['repositories'], previous)
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['repositories'] })
    },
  })
  return (
    <section className="repositories-page">
      <header className="page-heading">
        <div>
          <h1>Repositories</h1>
          <p className="muted">
            Where your tickets become changes. A kit lets agents run and prove
            changes in the running app.
          </p>
        </div>
      </header>
      <form
        className="repository-form"
        onSubmit={(event) => {
          event.preventDefault()
          add.mutate(input)
        }}
      >
        <label htmlFor="repository-input">Add a repository</label>
        <div className="input-row">
          <input
            id="repository-input"
            placeholder="owner/name or clone URL"
            required
            value={input}
            onChange={(event) => {
              setInput(event.target.value)
              add.reset()
            }}
          />
          <button className="primary" disabled={!input.trim() || add.isPending}>
            {add.isPending ? 'Adding…' : 'Add repository'}
          </button>
        </div>
        <ErrorMessage error={add.error} />
        {add.isSuccess && <output>Repository added. Waiting for setup.</output>}
      </form>
      <ErrorMessage error={query.error ?? policy.error} />
      {query.isPending && <p className="muted">Loading repositories…</p>}
      <ul className="repository-list">
        {query.data?.repositories.map((repository, index) => (
          <li
            key={repository.id}
            className="repository-card"
            style={{ '--i': index } as CSSProperties}
          >
            <div className="repository-head">
              <h2>
                <RepositoryDot id={repository.id} />
                {repository.slug}
              </h2>
              <Status value={repository.status} />
            </div>
            <p className={`kit-status ${repository.kit.status}`}>
              {KIT_WORDS[repository.kit.status]}
              <span className="muted"> · {repository.defaultBranch}</span>
            </p>
            {repository.kit.capabilities.length > 0 && (
              <div className="chips" aria-label="Kit capabilities">
                {repository.kit.capabilities.map((capability) => (
                  <span className="chip" key={capability}>
                    {capability}
                  </span>
                ))}
              </div>
            )}
            {repository.kit.error && (
              <p className="error">{repository.kit.error}</p>
            )}
            {repository.lastError && (
              <p className="error">{repository.lastError}</p>
            )}
            {repository.status === 'failed' && (
              <button
                type="button"
                className="button retry"
                disabled={retry.isPending}
                onClick={() => retry.mutate(repository.id)}
              >
                Retry
              </button>
            )}
            <label className="setting">
              <span className="setting-text">
                <span className="setting-name">Auto-merge safe changes</span>
                <span className="setting-hint">
                  Needs independent proof and a confident decision. Migrations,
                  kit and CI changes still need your review.
                </span>
              </span>
              <span className="toggle">
                <input
                  type="checkbox"
                  aria-label={`Auto-merge for ${repository.slug}`}
                  checked={
                    policy.isPending && policy.variables?.id === repository.id
                      ? policy.variables.enabled
                      : (repository.autoMerge ?? false)
                  }
                  disabled={policy.isPending}
                  onChange={(event) =>
                    policy.mutate({
                      id: repository.id,
                      enabled: event.target.checked,
                    })
                  }
                />
                <span aria-hidden="true" />
              </span>
            </label>
          </li>
        ))}
      </ul>
      {query.data?.repositories.length === 0 && (
        <p className="quiet-card">No repositories yet. Add one above.</p>
      )}
    </section>
  )
}
