import { useEffect, useState } from 'react'
import {
  QueryClient,
  queryOptions,
  useQueryClient,
} from '@tanstack/react-query'
import { api } from './api.ts'

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
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
            void client.invalidateQueries({ queryKey: ['tickets'] })
            void client.invalidateQueries({
              queryKey: ['ticket', event.ticketNumber],
            })
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
