import type { AssetSearchResult } from '@folio/shared'
import { fetchJson } from '@folio/sources'
import { Hono } from 'hono'
import { z } from 'zod'

import { fail, query } from '../http'
import type { AppEnv } from '../types'

const searchSchema = z.object({
  coins: z.array(
    z.object({
      id: z.string(),
      symbol: z.string(),
      name: z.string(),
      thumb: z.string().optional(),
      market_cap_rank: z.number().nullable().optional(),
    }),
  ),
})

const MAX_RESULTS = 12
const CACHE_SECONDS = 60 * 60

/** Asks CoinGecko's keyless search for coins by name or ticker. */
export async function searchAssets(
  fetch: typeof globalThis.fetch,
  q: string,
): Promise<AssetSearchResult[]> {
  const url = `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`
  const body = await fetchJson(fetch, url, searchSchema)
  return body.coins.slice(0, MAX_RESULTS).map((coin) => ({
    assetId: `coingecko:${coin.id}`,
    symbol: coin.symbol.toUpperCase(),
    name: coin.name,
    logo: coin.thumb ?? null,
    rank: coin.market_cap_rank ?? null,
  }))
}

/** Answers from the edge cache when it can: searches repeat, and the upstream is rate limited. */
export const assetRoutes = new Hono<AppEnv>().get(
  '/search',
  query(z.object({ q: z.string().trim().min(1).max(50) })),
  async (c) => {
    const q = c.req.valid('query').q.toLowerCase()
    const cache = typeof caches === 'undefined' ? undefined : caches.default
    const key = new Request(`https://folio.cache/assets/search?q=${encodeURIComponent(q)}`)
    const hit = await cache?.match(key)
    if (hit) return c.json<AssetSearchResult[]>(await hit.json())
    const results = await searchAssets(fetch, q).catch((error: unknown) => {
      console.warn(JSON.stringify({ message: 'asset search failed', error: String(error) }))
      return fail('upstream')
    })
    const response = Response.json(results, {
      headers: { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` },
    })
    if (cache) c.executionCtx.waitUntil(cache.put(key, response.clone()))
    return response
  },
)
