import { SourceError } from '../errors'
import type { FetchLike } from '../fetch'

/**
 * Turns an exchange's error code (and the HTTP status, when the answer failed) into a
 * SourceError, or undefined to fall back to the HTTP status mapping of `fetchJson`.
 */
export type ErrorCodeMapper = (code: string | undefined, status?: number) => SourceError | undefined

/** An error code from any of the envelopes the exchanges use (`code` / `retCode`). */
function errorCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const code = 'retCode' in body ? body.retCode : 'code' in body ? body.code : undefined
  return typeof code === 'string' || typeof code === 'number' ? String(code) : undefined
}

/**
 * Wraps a fetch so a failed answer that carries an exchange error code throws a SourceError with
 * a clear message (`fetchJson` rethrows SourceErrors from its fetch as they are). Answers
 * without a known code pass through, and `fetchJson` maps their HTTP status.
 *
 * Messages are ours, never the upstream's text: some upstream messages echo request details.
 */
export function withErrorCodes(fetch: FetchLike, map: ErrorCodeMapper): FetchLike {
  return async (input, init) => {
    const res = await fetch(input, init)
    if (res.ok) return res
    const body: unknown = await res
      .clone()
      .json()
      .catch(() => undefined)
    const code = errorCode(body)
    const error = map(code, res.status)
    if (error) throw error
    return res
  }
}

/** Throws the mapped error for a code an exchange returns inside a successful (200) answer. */
export function throwForCode(code: string, map: ErrorCodeMapper, venue: string): never {
  throw map(code) ?? new SourceError('upstream', `${venue} answered error code ${code}`)
}
