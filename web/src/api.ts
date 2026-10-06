import type {
  CreateRepositoryRequest,
  AutoMergeRequest,
  CreateTicketRequest,
  DecisionRequest,
  DecisionsResponse,
  OptionRequest,
  ErrorResponse,
  EventMessage,
  RepositoriesResponse,
  RepositoryResponse,
  ResolveRequest,
  TicketResponse,
  TicketsResponse,
  UploadWorkflowRequest,
  WorkflowResponse,
  WorkflowsResponse,
} from '../../src/api/contract.ts'

declare global {
  interface Window {
    KIPSTER_API_BASE_URL?: string
  }
}

// Configure before mounting the app, or at build time. No browser persistence.
const baseUrl = (
  window.KIPSTER_API_BASE_URL ??
  import.meta.env['VITE_API_BASE_URL'] ??
  ''
).replace(/\/$/, '')
const url = (path: string) => `${baseUrl}/api${path}`

/** A failed request; `summary` and `issues` keep the server's parts apart. */
export class ApiError extends Error {
  readonly summary: string
  readonly issues: readonly string[]

  constructor(summary: string, issues: readonly string[]) {
    super([summary, ...issues].join(': '))
    this.summary = summary
    this.issues = issues
  }
}

async function response(path: string, init?: RequestInit) {
  const result = await fetch(url(path), init)
  if (!result.ok) {
    const problem = (await result
      .json()
      .catch(() => null)) as ErrorResponse | null
    throw problem
      ? new ApiError(problem.error, problem.issues ?? [])
      : new ApiError(`Request failed (${result.status})`, [])
  }
  return result
}
async function get<T>(path: string, signal: AbortSignal): Promise<T> {
  return (await response(path, { signal })).json() as Promise<T>
}
async function post<T>(path: string, body: unknown): Promise<T> {
  return (
    await response(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  ).json() as Promise<T>
}

export const api = {
  retryRepository: (id: number) =>
    post<RepositoryResponse>(`/repositories/${id}/retry`, {}),
  setAutoMerge: (id: number, body: AutoMergeRequest) =>
    post<RepositoryResponse>(`/repositories/${id}/auto-merge`, body),
  decisions: (signal: AbortSignal) =>
    get<DecisionsResponse>('/decisions', signal),
  decideOption: (number: number, body: OptionRequest) =>
    post<TicketResponse>(`/tickets/${number}/option`, body),
  workflows: (signal: AbortSignal) =>
    get<WorkflowsResponse>('/workflows', signal),
  uploadWorkflow: (body: UploadWorkflowRequest) =>
    post<WorkflowResponse>('/workflows', body),
  repositories: (signal: AbortSignal) =>
    get<RepositoriesResponse>('/repositories', signal),
  tickets: (signal: AbortSignal) => get<TicketsResponse>('/tickets', signal),
  ticket: (number: number, signal: AbortSignal) =>
    get<TicketResponse>(`/tickets/${number}`, signal),
  cancel: (number: number, body: { reason?: string }) =>
    post<TicketResponse>(`/tickets/${number}/cancel`, body),
  createTicket: (body: CreateTicketRequest) =>
    post<TicketResponse>('/tickets', body),
  createRepository: (body: CreateRepositoryRequest) =>
    post<RepositoryResponse>('/repositories', body),
  decide: (number: number, body: DecisionRequest) =>
    post<TicketResponse>(`/tickets/${number}/decision`, body),
  resolve: (number: number, body: ResolveRequest) =>
    post<TicketResponse>(`/tickets/${number}/resolve`, body),
  artifactUrl: (id: number) => url(`/artifacts/${id}`),
  artifact: async (id: number, signal: AbortSignal) =>
    (await response(`/artifacts/${id}`, { signal })).text(),
  events(
    onEvent: (event: EventMessage) => void,
    onState: (state: 'ready' | 'reconnecting') => void,
  ) {
    const stream = new EventSource(url('/events'))
    stream.addEventListener('ready', () => onState('ready'))
    stream.onmessage = (message) =>
      onEvent(JSON.parse(message.data) as EventMessage)
    stream.onerror = () => onState('reconnecting')
    // The native EventSource retries drops and supplies Last-Event-ID.
    return () => stream.close()
  },
}
