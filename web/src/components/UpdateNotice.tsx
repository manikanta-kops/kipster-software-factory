import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UpdateResponse } from '../../../src/api/contract.ts'
import { api } from '../api.ts'
import { updateQuery } from '../queries.ts'
import { ErrorMessage } from './Shared.tsx'

const LABEL: Record<UpdateResponse['state'], string> = {
  none: '',
  available: 'Update available',
  waiting: 'Update waiting',
  installing: 'Updating…',
  failed: 'Update failed',
}

const steps = (count: number) =>
  `${count} running ${count === 1 ? 'step' : 'steps'}`

/** A header pill that appears when a newer release can be installed. */
export function UpdateNotice() {
  const client = useQueryClient()
  const query = useQuery({
    ...updateQuery,
    refetchInterval: (current) =>
      ['waiting', 'installing'].includes(current.state.data?.state ?? '') ||
      current.state.error
        ? 3_000
        : 5 * 60_000,
  })
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState<string | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const status = query.data
  const onSuccess = (data: UpdateResponse) =>
    client.setQueryData(updateQuery.queryKey, data)
  // Remember the version being installed so the restarted factory can confirm it.
  if (
    (status?.state === 'waiting' || status?.state === 'installing') &&
    status.latest !== target
  )
    setTarget(status.latest)
  const start = useMutation({ mutationFn: api.requestUpdate, onSuccess })
  const cancel = useMutation({ mutationFn: api.cancelUpdate, onSuccess })

  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent | MouseEvent) => {
      if (
        event instanceof KeyboardEvent
          ? event.key === 'Escape'
          : !panel.current?.contains(event.target as Node)
      )
        setOpen(false)
    }
    document.addEventListener('keydown', close)
    document.addEventListener('mousedown', close)
    return () => {
      document.removeEventListener('keydown', close)
      document.removeEventListener('mousedown', close)
    }
  }, [open])

  if (!status) return null
  if (target && status.current === target)
    return (
      <div className="update">
        <button
          type="button"
          className="update-pill done"
          onClick={() => window.location.reload()}
        >
          Updated to v{target} · Reload
        </button>
      </div>
    )
  if (status.state === 'none') return null

  return (
    <div className="update" ref={panel}>
      <button
        type="button"
        className={`update-pill ${status.state}`}
        aria-expanded={open}
        aria-controls="update-panel"
        onClick={() => setOpen(!open)}
      >
        {LABEL[status.state]}
      </button>
      {open && (
        <div id="update-panel" className="update-panel">
          {status.state === 'available' && (
            <>
              <p>
                <strong>v{status.latest}</strong> is available. This factory
                runs v{status.current}.
              </p>
              {status.blocked ? (
                <p className="muted">{status.blocked}</p>
              ) : (
                <>
                  <p className="muted">
                    New steps wait while running steps finish, then the factory
                    installs the update and restarts.
                    {status.automatic && ' Otherwise it installs tonight.'}
                  </p>
                  <button
                    type="button"
                    className="button primary"
                    disabled={start.isPending}
                    onClick={() => start.mutate()}
                  >
                    Update now
                  </button>
                </>
              )}
            </>
          )}
          {status.state === 'waiting' && (
            <>
              <p>
                Updating to <strong>v{status.latest}</strong> after{' '}
                {steps(status.running)} finish.
              </p>
              <p className="muted">New steps start after the update.</p>
              <button
                type="button"
                className="button"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                Cancel update
              </button>
            </>
          )}
          {status.state === 'installing' && (
            <p>
              Installing <strong>v{status.latest}</strong>. The factory restarts
              in a moment.
            </p>
          )}
          {status.state === 'failed' && (
            <>
              <p>
                The update to <strong>v{status.latest}</strong> failed:{' '}
                {status.error}
              </p>
              <p className="muted">See logs/update.log in the factory home.</p>
              {!status.blocked && (
                <button
                  type="button"
                  className="button"
                  disabled={start.isPending}
                  onClick={() => start.mutate()}
                >
                  Try again
                </button>
              )}
            </>
          )}
          {status.notes && (
            <a
              className="text-link"
              href={status.notes}
              target="_blank"
              rel="noreferrer"
            >
              Release notes
            </a>
          )}
          <ErrorMessage error={start.error ?? cancel.error} />
        </div>
      )}
    </div>
  )
}
