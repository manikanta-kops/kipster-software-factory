import { useEffect, useState } from 'react'
import {
  QueryClient,
  queryOptions,
  useQueryClient,
} from '@tanstack/react-query'
import { api } from './api.ts'
import type { TicketResponse } from '../../src/api/contract.ts'

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
})
export const decisionsQuery = queryOptions({
  queryKey: ['decisions'],
  queryFn: ({ signal }) => api.decisions(signal),
})
export const ticketsQuery = queryOptions({
  queryKey: ['tickets'],
  queryFn: ({ signal }) => api.tickets(signal),
})
export const repositoriesQuery = queryOptions({
  queryKey: ['repositories'],
  queryFn: ({ signal }) => api.repositories(signal),
})
export const workflowsQuery = queryOptions({
  queryKey: ['workflows'],
  queryFn: ({ signal }) => api.workflows(signal),
})
export const settingsQuery = queryOptions({
  queryKey: ['settings'],
  queryFn: ({ signal }) => api.settings(signal),
})
export const ticketQuery = (number: number) =>
  queryOptions({
    queryKey: ['ticket', number],
    queryFn: ({ signal }) => api.ticket(number, signal),
  })

export function useLiveEvents() {
  const client = useQueryClient()
  const [state, setState] = useState<'connecting' | 'ready' | 'reconnecting'>(
    'connecting',
  )
  useEffect(
    () =>
      api.events(
        (event) => {
          if (event.ticketNumber !== null) {
            void client.invalidateQueries({ queryKey: ['decisions'] })
            void client.invalidateQueries({ queryKey: ['tickets'] })
            void client.invalidateQueries({
              queryKey: ['ticket', event.ticketNumber],
            })
            for (const [
              queryKey,
              detail,
            ] of client.getQueriesData<TicketResponse>({
              queryKey: ['ticket'],
            }))
              if (
                detail?.links?.some((link) =>
                  [link.original.number, link.linked.number].includes(
                    event.ticketNumber!,
                  ),
                )
              )
                void client.invalidateQueries({ queryKey })
          }
          if (event.kind.startsWith('repository.'))
            void client.invalidateQueries({ queryKey: ['repositories'] })
        },
        (next) => {
          setState(next)
          // Reconcile the initial fetch/stream race and any changes during a disconnect.
          if (next === 'ready') void client.invalidateQueries()
        },
      ),
    [client],
  )
  return state
}
