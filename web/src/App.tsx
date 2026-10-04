import type { MouseEvent, ReactNode } from 'react'
import { api } from './api.ts'
import { Logo } from './components/Logo.tsx'
import { NeedsYou } from './pages/NeedsYou.tsx'
import { Workflows } from './pages/Workflows.tsx'
import { navigate, usePath } from './router.ts'
import { useResource } from './useResource.ts'

export function App() {
  const path = usePath()
  const health = useResource(api.health)
  const onWorkflows = path.startsWith('/workflows')

  return (
    <div className="shell">
      <header className="bar">
        <Link to="/" className="brand">
          <Logo />
          <span>Kipster Software Factory</span>
        </Link>
        <nav aria-label="Main">
          <Link to="/" current={!onWorkflows}>
            Needs you
          </Link>
          <Link to="/workflows" current={onWorkflows}>
            Workflows
          </Link>
        </nav>
        <output
          className={`status ${health.state}`}
          title={health.state === 'failed' ? health.error : undefined}
        >
          {health.state === 'ready'
            ? 'Online'
            : health.state === 'loading'
              ? 'Connecting'
              : 'Offline'}
        </output>
      </header>
      <main>
        {onWorkflows ? (
          <Workflows selected={path.split('/')[2]} />
        ) : (
          <NeedsYou />
        )}
      </main>
    </div>
  )
}

function Link({
  to,
  current,
  className,
  children,
}: {
  to: string
  current?: boolean
  className?: string
  children: ReactNode
}) {
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
      return
    event.preventDefault()
    navigate(to)
  }
  return (
    <a
      href={to}
      onClick={follow}
      className={className}
      aria-current={current ? 'page' : undefined}
    >
      {children}
    </a>
  )
}
