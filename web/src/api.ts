import type {
  HealthResponse,
  WorkflowsResponse,
} from '../../src/api/contract.ts'

async function get<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal })
  if (!response.ok) {
    throw new Error(`${path} answered ${response.status}`)
  }
  return (await response.json()) as T
}

export const api = {
  health: (signal: AbortSignal) => get<HealthResponse>('/api/health', signal),
  workflows: (signal: AbortSignal) =>
    get<WorkflowsResponse>('/api/workflows', signal),
}
