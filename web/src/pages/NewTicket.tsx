import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Repository, WorkflowSummary } from '../../../src/api/contract.ts'
import { api } from '../api.ts'
import { ErrorMessage, MarkdownBody } from '../components/Shared.tsx'
import { repositoriesQuery, workflowsQuery } from '../queries.ts'
import { navigate } from '../router.ts'

function unavailable(
  repository: Repository | undefined,
  workflow: WorkflowSummary,
) {
  if (!repository) return 'Choose a repository first.'
  if (repository.status !== 'ready')
    return `Repository is ${repository.status}. It must be ready to start a ticket.`
  const missing = [
    ...new Set(workflow.steps.flatMap((step) => step.needs)),
  ].filter((need) => !repository.capabilities.includes(need))
  return missing.length ? `Missing capabilities: ${missing.join(', ')}.` : null
}
export function NewTicket() {
  const repositories = useQuery(repositoriesQuery)
  const workflows = useQuery(workflowsQuery)
  const client = useQueryClient()
  const [repository, setRepository] = useState('')
  const [workflow, setWorkflow] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const selectedRepository = repositories.data?.repositories.find(
    (item) => item.slug === repository,
  )
  const selectedWorkflow = workflows.data?.workflows.find(
    (item) => item.name === workflow,
  )
  const canCreate =
    selectedWorkflow &&
    !unavailable(selectedRepository, selectedWorkflow) &&
    title.trim()
  const create = useMutation({
    mutationFn: api.createTicket,
    onSuccess: (data) => {
      void client.invalidateQueries({ queryKey: ['tickets'] })
      client.setQueryData(['ticket', data.ticket.number], data)
      navigate(`/tickets/${data.ticket.number}`)
    },
  })
  return (
    <section className="form-page">
      <header className="page-heading">
        <div>
          <h1>New ticket</h1>
          <p className="muted">Describe the change. Choose how it gets done.</p>
        </div>
      </header>
      <ErrorMessage error={repositories.error ?? workflows.error} />
      {repositories.isPending || workflows.isPending ? (
        <p className="muted">Loading repositories and workflows…</p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (canCreate)
              create.mutate({ repository, workflow, title: title.trim(), body })
          }}
        >
          <label htmlFor="repository">Repository</label>
          <select
            id="repository"
            required
            value={repository}
            onChange={(event) => {
              setRepository(event.target.value)
              setWorkflow('')
            }}
          >
            <option value="">Choose a repository</option>
            {repositories.data?.repositories.map((item) => (
              <option key={item.id} value={item.slug}>
                {item.slug} ({item.status})
              </option>
            ))}
          </select>
          {repositories.data?.repositories.length === 0 && (
            <p className="muted">
              No repositories yet.{' '}
              <a className="text-link" href="#/repositories">
                Add a repository
              </a>{' '}
              to start.
            </p>
          )}
          <fieldset className="workflow-choices">
            <legend>Workflow</legend>
            {workflows.data?.workflows.map((item) => {
              const reason = unavailable(selectedRepository, item)
              return (
                <label
                  key={item.name}
                  className={`workflow-choice ${reason ? 'unavailable' : ''}`}
                >
                  <input
                    type="radio"
                    name="workflow"
                    value={item.name}
                    checked={workflow === item.name}
                    disabled={Boolean(reason)}
                    onChange={() => setWorkflow(item.name)}
                  />
                  <span>
                    <strong>{item.name}</strong>
                    <span>{item.description}</span>
                    {reason && <small>{reason}</small>}
                  </span>
                </label>
              )
            })}
          </fieldset>
          <label htmlFor="title">Title</label>
          <input
            id="title"
            required
            maxLength={200}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <label htmlFor="body">
            Description <span className="muted">Markdown supported</span>
          </label>
          <textarea
            id="body"
            rows={7}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          {body && (
            <details className="preview">
              <summary>Preview description</summary>
              <MarkdownBody>{body}</MarkdownBody>
            </details>
          )}
          <ErrorMessage error={create.error} />
          <div className="actions">
            <button
              className="primary"
              disabled={!canCreate || create.isPending}
            >
              {create.isPending ? 'Creating…' : 'Create ticket'}
            </button>
            <a className="button" href="#/">
              Cancel
            </a>
          </div>
        </form>
      )}
    </section>
  )
}
