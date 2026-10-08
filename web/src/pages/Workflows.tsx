import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ChangeEvent, useState } from 'react'
import { ApiError, api } from '../api.ts'
import { workflowsQuery } from '../queries.ts'
import { WorkflowDiagram } from '../components/WorkflowDiagram.tsx'

export function Workflows({ selected }: { selected: string | undefined }) {
  const resource = useQuery(workflowsQuery)
  const [removed, setRemoved] = useState<string | null>(null)

  if (resource.isPending) {
    return <p className="muted">Loading workflows…</p>
  }
  if (resource.isError) {
    return (
      <p className="error" role="alert">
        Could not load workflows: {resource.error.message}
      </p>
    )
  }

  const { workflows } = resource.data
  const current =
    workflows.find((workflow) => workflow.name === selected) ?? workflows[0]
  if (!current) return <p className="muted">No workflows are loaded.</p>

  return (
    <div className="workflows">
      <nav className="workflow-list" aria-label="Workflows">
        <h1>Workflows</h1>
        <ul>
          {workflows.map((workflow) => (
            <li key={workflow.name}>
              <a
                href={`#/workflows/${workflow.name}`}
                aria-current={workflow === current ? 'page' : undefined}
              >
                <span className="name">
                  {workflow.name}
                  {workflow.origin === 'upload' ? (
                    <>
                      {' '}
                      <span className="origin">uploaded</span>
                    </>
                  ) : null}
                </span>
                <span className="description">{workflow.description}</span>
              </a>
            </li>
          ))}
        </ul>
        <UploadWorkflow />
      </nav>
      <article className="workflow" aria-labelledby="workflow-name">
        {removed && selected === undefined ? (
          <output className="workflow-removed">Removed {removed}.</output>
        ) : null}
        {selected !== undefined && selected !== current.name ? (
          <p className="workflow-removed muted">
            {selected} is not in the library. Tickets that ran it keep their
            copy.
          </p>
        ) : null}
        <header>
          <h2 id="workflow-name">{current.name}</h2>
          <p className="muted">{current.description}</p>
          <p className="version">
            version {current.version}
            {current.origin === 'upload' ? ' · uploaded' : ''}
          </p>
          {current.origin === 'upload' ? (
            <RemoveWorkflow
              key={current.name}
              name={current.name}
              onRemoved={setRemoved}
            />
          ) : null}
        </header>
        <WorkflowDiagram key={current.name} workflow={current} />
        <p className="legend muted">
          Every agent and system step can also stop and ask you.
        </p>
      </article>
    </div>
  )
}

function UploadWorkflow() {
  const client = useQueryClient()
  const [saved, setSaved] = useState<string | null>(null)
  const upload = useMutation({
    mutationFn: async (file: File) =>
      api.uploadWorkflow({ source: await file.text() }),
    onMutate: () => setSaved(null),
    onSuccess: async ({ workflow }) => {
      await client.invalidateQueries({ queryKey: ['workflows'] })
      setSaved(`Saved ${workflow.name}, version ${workflow.version}.`)
      window.location.hash = `#/workflows/${workflow.name}`
    },
  })

  function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    // Clearing lets the same file be chosen again after fixing it.
    event.target.value = ''
    if (file) upload.mutate(file)
  }

  const error = upload.error
  return (
    <div className="workflow-upload">
      <label className="button" aria-disabled={upload.isPending}>
        {upload.isPending ? 'Uploading…' : 'Upload workflow'}
        <input
          type="file"
          accept=".yml,.yaml"
          onChange={choose}
          disabled={upload.isPending}
        />
      </label>
      <p className="muted">
        A YAML workflow file. It is checked before it is saved, and tickets
        already running keep their version.
      </p>
      {saved ? <output>{saved}</output> : null}
      {error ? (
        <div className="error" role="alert">
          <p>{error instanceof ApiError ? error.summary : error.message}</p>
          {error instanceof ApiError && error.issues.length > 0 ? (
            <ul>
              {error.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function RemoveWorkflow({
  name,
  onRemoved,
}: {
  name: string
  onRemoved: (name: string) => void
}) {
  const client = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const remove = useMutation({
    mutationFn: () => api.removeWorkflow(name),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['workflows'] })
      onRemoved(name)
      window.location.hash = '#/workflows'
    },
  })

  const error = remove.error
  return (
    <div className="workflow-remove">
      {confirming ? (
        <fieldset className="workflow-remove-confirm">
          <legend>Remove {name}?</legend>
          <p>
            New tickets can no longer use it. Finished tickets keep their copy.
          </p>
          <div className="actions">
            <button
              type="button"
              className="danger"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending ? 'Removing…' : 'Remove workflow'}
            </button>
            <button
              type="button"
              className="quiet"
              disabled={remove.isPending}
              onClick={() => {
                setConfirming(false)
                remove.reset()
              }}
            >
              Keep it
            </button>
          </div>
        </fieldset>
      ) : (
        <button
          type="button"
          className="danger"
          onClick={() => setConfirming(true)}
        >
          Remove
        </button>
      )}
      {error ? (
        <p className="error" role="alert">
          {error instanceof ApiError ? error.summary : error.message}
        </p>
      ) : null}
    </div>
  )
}
