import { fetchJson } from '@folio/sources'
import { z } from 'zod'

import { DEFAULT_UPSTREAMS } from '../upstreams'

/** Ids per request: keeps URLs well under common length limits. */
export const DEFILLAMA_BATCH = 80
/** Prices DefiLlama is less sure about than this are ignored. */
const MIN_CONFIDENCE = 0.8

const pricesSchema = z.object({
  coins: z.record(
    z.string(),
    z.object({
      price: z.number(),
      symbol: z.string().optional(),
      confidence: z.number().optional(),
      timestamp: z.number(),
    }),
  ),
})

const percentageSchema = z.object({ coins: z.record(z.string(), z.number()) })

export interface Quote {
  priceUsd: number
  /** 24h change as a ratio (0.01 = +1%), when known. */
  change24h: number | null
}

/**
 * Current USD prices and 24h changes for asset ids in DefiLlama's format, which is ours
 * (`coingecko:<id>`, `<chain>:<address>`). Two requests per batch.
 */
export async function fetchQuotes(
  fetch: typeof globalThis.fetch,
  assetIds: string[],
  base = DEFAULT_UPSTREAMS.defillama,
): Promise<Map<string, Quote>> {
  const quotes = new Map<string, Quote>()
  for (let i = 0; i < assetIds.length; i += DEFILLAMA_BATCH) {
    const ids = assetIds
      .slice(i, i + DEFILLAMA_BATCH)
      .map(encodeURIComponent)
      .join(',')
    // oxlint-disable-next-line no-await-in-loop -- batches share one subrequest budget
    const [prices, changes] = await Promise.all([
      fetchJson(fetch, `${base}/prices/current/${ids}?searchWidth=4h`, pricesSchema),
      fetchJson(fetch, `${base}/percentage/${ids}?period=24h`, percentageSchema),
    ])
    for (const [id, coin] of Object.entries(prices.coins)) {
      if ((coin.confidence ?? 1) < MIN_CONFIDENCE) continue
      const percent = changes.coins[id]
      quotes.set(id, {
        priceUsd: coin.price,
        change24h: percent === undefined ? null : percent / 100,
      })
    }
  }
  return quotes
}
