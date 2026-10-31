import { z } from 'zod'

import { SourceError } from './errors'
import { fetchJson, type FetchLike } from './fetch'

/** JSON-RPC error codes public nodes use when they throttle (Solana answers 429 in the body). */
const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([429, -32005])

const rpcError = z.object({ code: z.number(), message: z.string() })

/**
 * Calls one JSON-RPC 2.0 method and checks `result` against `schema`. HTTP failures map as in
 * `fetchJson`; an `error` member in the body maps to `rate_limited` or `upstream`.
 */
export async function rpcCall<T extends z.ZodType>(
  fetch: FetchLike,
  url: string,
  method: string,
  params: unknown[],
  schema: T,
): Promise<z.output<T>> {
  const answer = await fetchJson(
    fetch,
    url,
    z.object({ result: z.unknown().optional(), error: rpcError.optional() }),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    },
  )
  const host = new URL(url).host
  if (answer.error) {
    if (RATE_LIMIT_CODES.has(answer.error.code)) {
      throw new SourceError('rate_limited', `${host} rate limited the sync`)
    }
    throw new SourceError('upstream', `${host} answered ${method} with error ${answer.error.code}`)
  }
  const result = schema.safeParse(answer.result)
  if (!result.success) {
    throw new SourceError('upstream', `${host} answered ${method} with an unexpected shape`, {
      cause: result.error,
    })
  }
  return result.data
}
