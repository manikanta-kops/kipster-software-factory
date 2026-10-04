import { useSyncExternalStore } from 'react'

function subscribe(listener: () => void) {
  window.addEventListener('hashchange', listener)
  return () => window.removeEventListener('hashchange', listener)
}
export function usePath(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.hash.slice(1) || '/',
  )
}
export function navigate(path: string) {
  window.location.hash = path
}
