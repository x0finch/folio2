import type { z } from 'zod'

import { SourceError } from './errors'

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * A fetch that counts its requests and refuses past `limit`. The sync engine gives each plugin
 * one, sized from what is left of the Worker's per-invocation subrequest limit.
 */
export interface BudgetedFetch extends FetchLike {
  readonly budget: { readonly used: number; readonly limit: number }
}

export function budgetedFetch(inner: FetchLike, limit: number): BudgetedFetch {
  const budget = { used: 0, limit }
  const fetch: FetchLike = async (input, init) => {
    if (budget.used >= limit) {
      throw new SourceError('budget', `Subrequest budget of ${limit} exhausted`)
    }
    budget.used += 1
    return inner(input, init)
  }
  return Object.assign(fetch, { budget })
}

const USER_AGENT = 'Folio/1.0 (self-hosted portfolio tracker)'

/**
 * Fetches JSON and checks it against `schema`. Maps HTTP failures to source error codes so
 * plugins don't have to.
 */
export async function fetchJson<T extends z.ZodType>(
  fetch: FetchLike,
  url: string | URL,
  schema: T,
  init?: RequestInit,
): Promise<z.output<T>> {
  const headers = new Headers(init?.headers)
  if (!headers.has('accept')) headers.set('accept', 'application/json')
  // Workers send no User-Agent by default, and some APIs (CoinGecko) refuse requests without one.
  if (!headers.has('user-agent')) headers.set('user-agent', USER_AGENT)
  let res: Response
  try {
    res = await fetch(url, { ...init, headers })
  } catch (error) {
    if (error instanceof SourceError) throw error
    throw new SourceError('upstream', `Request to ${new URL(url).host} failed`, { cause: error })
  }
  const host = new URL(url).host
  if (res.status === 429) throw new SourceError('rate_limited', `${host} rate limited the sync`)
  if (res.status === 401 || res.status === 403) {
    throw new SourceError('unauthorized', `${host} refused the credentials (${res.status})`)
  }
  if (!res.ok) throw new SourceError('upstream', `${host} answered ${res.status}`)
  const body: unknown = await res.json().catch(() => undefined)
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new SourceError('upstream', `${host} answered an unexpected shape`, {
      cause: parsed.error,
    })
  }
  return parsed.data
}
