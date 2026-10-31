/** Why a source failed. Transient codes are retried; the others need the user to act. */
export type SourceErrorCode =
  /** The saved config is wrong (bad address, malformed key). */
  | 'invalid_config'
  /** The upstream refused the credentials or they lack a permission. */
  | 'unauthorized'
  /** The upstream asked us to slow down. */
  | 'rate_limited'
  /** The upstream failed or answered something unexpected. */
  | 'upstream'
  /** The sync ran out of its subrequest budget. */
  | 'budget'

const TRANSIENT: ReadonlySet<SourceErrorCode> = new Set(['rate_limited', 'upstream', 'budget'])

export class SourceError extends Error {
  override readonly name = 'SourceError'

  constructor(
    readonly code: SourceErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }

  get transient() {
    return TRANSIENT.has(this.code)
  }
}

/** Any thrown value as a SourceError; unknown errors count as upstream failures. */
export function toSourceError(error: unknown): SourceError {
  if (error instanceof SourceError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new SourceError('upstream', message, { cause: error })
}
