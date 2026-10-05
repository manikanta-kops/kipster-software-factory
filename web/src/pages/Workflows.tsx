import { useQuery } from '@tanstack/react-query'
import { workflowsQuery } from '../queries.ts'
import { WorkflowDiagram } from '../components/WorkflowDiagram.tsx'

export function Workflows({ selected }: { selected: string | undefined }) {
  const resource = useQuery(workflowsQuery)

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
                <span className="name">{workflow.name}</span>
                <span className="description">{workflow.description}</span>
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <article className="workflow" aria-labelledby="workflow-name">
        <header>
          <h2 id="workflow-name">{current.name}</h2>
          <p className="muted">{current.description}</p>
          <p className="version">version {current.version}</p>
        </header>
        <WorkflowDiagram key={current.name} workflow={current} />
        <p className="legend muted">
          Every agent and system step can also stop and ask you.
        </p>
      </article>
    </div>
  )
}
