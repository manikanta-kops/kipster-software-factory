import { useEffect, useRef } from 'react'
import { Logo } from './components/Logo.tsx'
import { NeedsYou } from './pages/NeedsYou.tsx'
import { Workflows } from './pages/Workflows.tsx'
import { NewTicket } from './pages/NewTicket.tsx'
import { TicketPage } from './pages/Ticket.tsx'
import { Repositories } from './pages/Repositories.tsx'
import { usePath } from './router.ts'
import { useLiveEvents } from './queries.ts'

export function App() {
  const path = usePath()
  const live = useLiveEvents()
  const main = useRef<HTMLElement>(null)
  useEffect(() => {
    document.title =
      path === '/'
        ? 'Needs you · Kipster'
        : `${path.split('/').filter(Boolean).join(' / ')} · Kipster`
    main.current?.focus()
  }, [path])
  const ticket = /^\/tickets\/(\d+)(?:\/evidence\/(\d+))?$/.exec(path)
  const onWorkflows = path.startsWith('/workflows')
  return (
    <div className="shell">
      <a
        className="skip-link"
        href="#main"
        onClick={(event) => {
          event.preventDefault()
          main.current?.focus()
        }}
      >
        Skip to content
      </a>
      <header className="bar">
        <a
          href="#/"
          className="brand"
          aria-label="Kipster Software Factory home"
        >
          <Logo />
          <span>Kipster Software Factory</span>
        </a>
        <nav aria-label="Main">
          <a href="#/" aria-current={path === '/' ? 'page' : undefined}>
            Needs you
          </a>
          <a
            href="#/repositories"
            aria-current={path === '/repositories' ? 'page' : undefined}
          >
            Repositories
          </a>
          <a href="#/workflows" aria-current={onWorkflows ? 'page' : undefined}>
            Workflows
          </a>
        </nav>
        <output
          className={`status ${live}`}
          aria-live="polite"
          title="Live updates"
        >
          {live === 'ready'
            ? 'Live'
            : live === 'connecting'
              ? 'Connecting'
              : 'Reconnecting'}
        </output>
      </header>
      <main id="main" ref={main} tabIndex={-1}>
        {path === '/' ? (
          <NeedsYou />
        ) : path === '/tickets/new' ? (
          <NewTicket />
        ) : ticket ? (
          <TicketPage
            key={ticket[1]}
            number={Number(ticket[1])}
            {...(ticket[2] ? { evidenceId: Number(ticket[2]) } : {})}
          />
        ) : path === '/repositories' ? (
          <Repositories />
        ) : onWorkflows ? (
          <Workflows selected={path.split('/')[2]} />
        ) : (
          <section className="quiet">
            <h1>Page not found</h1>
            <a href="#/" className="text-link">
              Back to Needs you
            </a>
          </section>
        )}
      </main>
    </div>
  )
}
