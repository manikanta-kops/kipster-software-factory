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
