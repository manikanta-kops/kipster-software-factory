import { useEffect, useState } from 'react'

export type Resource<T> =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly data: T }
  | { readonly state: 'failed'; readonly error: string }

/** Loads data once per mount and aborts the request when the component goes away. */
export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
): Resource<T> {
  const [resource, setResource] = useState<Resource<T>>({ state: 'loading' })
  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal).then(
      (data) => setResource({ state: 'ready', data }),
      (error: unknown) => {
        if (controller.signal.aborted) return
        setResource({
          state: 'failed',
          error: error instanceof Error ? error.message : String(error),
        })
      },
    )
    return () => controller.abort()
  }, [load])
  return resource
}
