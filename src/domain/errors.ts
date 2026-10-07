export type FactoryErrorCode = 'invalid' | 'not-found' | 'conflict'

/**
 * A request the factory refuses: `invalid` input, a `not-found` reference, or a
 * `conflict` with the current state (for example, an attempt that already moved on).
 */
export class FactoryError extends Error {
  readonly code: FactoryErrorCode

  constructor(code: FactoryErrorCode, message: string) {
    super(message)
    this.name = 'FactoryError'
    this.code = code
  }
}

/** The attempt already finished; whoever acted second has nothing left to do. */
export class AttemptMovedOn extends FactoryError {
  constructor(message: string) {
    super('conflict', message)
  }
}

/** An uploaded workflow that unfinished tickets or tasks still need. */
export class WorkflowInUse extends FactoryError {
  readonly tickets: readonly number[]

  constructor(name: string, tickets: readonly number[]) {
    super(
      'conflict',
      `"${name}" is used by unfinished tickets ${tickets.map((n) => `#${n}`).join(', ')}; finish or cancel them first`,
    )
    this.tickets = tickets
  }
}
