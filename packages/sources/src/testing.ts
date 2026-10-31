import type { z } from 'zod'

import type { Source, SourceContext, SourceLog } from './define'
import { budgetedFetch, type FetchLike } from './fetch'

export interface FixtureRoute {
  /** Matches when the request URL contains this string, or matches this pattern. */
  url: string | RegExp
  method?: string
  /** Optional check on the request body (for JSON-RPC style APIs). */
  body?: (body: string) => boolean
  status?: number
  json: unknown
}

export interface RecordedRequest {
  method: string
  url: string
  headers: Headers
  body: string
}

/**
 * A fetch answering from fixtures, recording every request. Unmatched requests fail the test
 * instead of reaching the network.
 */
export function fixtureFetch(routes: FixtureRoute[]) {
  const requests: RecordedRequest[] = []
  const fetch: FetchLike = async (input, init) => {
    const request = new Request(input, init)
    const body = request.body ? await request.text() : ''
    requests.push({ method: request.method, url: request.url, headers: request.headers, body })
    const route = routes.find(
      (candidate) =>
        (typeof candidate.url === 'string'
          ? request.url.includes(candidate.url)
          : candidate.url.test(request.url)) &&
        (candidate.method ?? 'GET') === request.method &&
        (candidate.body?.(body) ?? true),
    )
    if (!route) throw new Error(`No fixture for ${request.method} ${request.url} ${body}`)
    return Response.json(route.json, { status: route.status ?? 200 })
  }
  return { fetch, requests }
}

/** A log that keeps every line, so tests can assert that secrets never reach it. */
export function memoryLog(): SourceLog & { lines: string[] } {
  const lines: string[] = []
  const write = (message: string, data?: Record<string, unknown>) =>
    lines.push(data ? `${message} ${JSON.stringify(data)}` : message)
  return { lines, info: write, warn: write }
}

/** Runs a plugin the way the sync engine does: config parsed, fetch budgeted. */
export function contextFor<S extends z.ZodObject>(
  source: Source<S>,
  rawConfig: z.input<S>,
  fetch: FetchLike,
  now = new Date('2026-10-01T00:00:00Z'),
): SourceContext<z.output<S>> & { log: ReturnType<typeof memoryLog> } {
  const config = source.config.parse(rawConfig)
  return {
    config,
    fetch: budgetedFetch(fetch, source.maxRequests(config)),
    log: memoryLog(),
    now,
  }
}
