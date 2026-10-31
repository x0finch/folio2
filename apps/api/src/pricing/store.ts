import { DISPLAY_CURRENCIES, type RatesResponse } from '@folio/shared'
import { canonicalAssetId } from '@folio/sources'
import { eq, inArray, sql } from 'drizzle-orm'

import type { Db } from '../db'
import { fxRates, positions, prices } from '../db/schema'
import { type Quote, fetchQuotes } from './defillama'
import { fetchFiatRates } from './frankfurter'

/** Prices younger than this are not fetched again. */
export const PRICE_TTL_MS = 5 * 60_000
/** ECB rates change once a day. */
export const FX_TTL_MS = 12 * 60 * 60_000
/** Display currencies priced from the feed rather than FX rates. */
export const CRYPTO_CURRENCIES = { BTC: 'coingecko:bitcoin', ETH: 'coingecko:ethereum' } as const

/** D1 allows 100 bound parameters per statement. */
const IN_CHUNK = 90

function chunk<T>(items: T[], size: number): T[][] {
  const parts: T[][] = []
  for (let i = 0; i < items.length; i += size) parts.push(items.slice(i, i + size))
  return parts
}

export async function loadQuotes(db: Db, assetIds: string[]): Promise<Map<string, Quote>> {
  const quotes = new Map<string, Quote>()
  for (const ids of chunk([...new Set(assetIds)], IN_CHUNK)) {
    // oxlint-disable-next-line no-await-in-loop -- few chunks, D1 serializes anyway
    const rows = await db.select().from(prices).where(inArray(prices.assetId, ids))
    for (const row of rows) {
      quotes.set(row.assetId, { priceUsd: row.priceUsd, change24h: row.change24h })
    }
  }
  return quotes
}

/** The asset ids a user's positions need priced (canonical ids, plus BTC/ETH for display). */
export async function assetIdsOf(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ assetId: positions.assetId })
    .from(positions)
    .where(eq(positions.userId, userId))
  return [
    ...new Set([
      ...rows.map((row) => canonicalAssetId(row.assetId)),
      ...Object.values(CRYPTO_CURRENCIES),
    ]),
  ]
}

/** Fetches prices that are missing or older than the TTL, and stores them. */
export async function refreshPrices(
  db: Db,
  fetch: typeof globalThis.fetch,
  assetIds: string[],
  now: number,
): Promise<number> {
  const known = new Map<string, number>()
  for (const ids of chunk(assetIds, IN_CHUNK)) {
    // oxlint-disable-next-line no-await-in-loop -- few chunks
    const rows = await db
      .select({ assetId: prices.assetId, updatedAt: prices.updatedAt })
      .from(prices)
      .where(inArray(prices.assetId, ids))
    for (const row of rows) known.set(row.assetId, row.updatedAt.getTime())
  }
  const stale = assetIds.filter((id) => now - (known.get(id) ?? 0) >= PRICE_TTL_MS)
  if (!stale.length) return 0
  const quotes = await fetchQuotes(fetch, stale)
  const rows = [...quotes].map(([assetId, quote]) => ({
    assetId,
    priceUsd: quote.priceUsd,
    change24h: quote.change24h,
    updatedAt: new Date(now),
  }))
  // 4 columns per row: 20 rows per statement stays under the parameter limit.
  const statements = chunk(rows, 20).map((part) =>
    db
      .insert(prices)
      .values(part)
      .onConflictDoUpdate({
        target: prices.assetId,
        set: {
          priceUsd: sql`excluded.price_usd`,
          change24h: sql`excluded.change_24h`,
          updatedAt: sql`excluded.updated_at`,
        },
      }),
  )
  const [first, ...rest] = statements
  if (first) await db.batch([first, ...rest])
  return rows.length
}

/** Refreshes fiat rates when they are older than a day's half. */
export async function refreshFx(db: Db, fetch: typeof globalThis.fetch, now: number) {
  const [newest] = await db
    .select({ updatedAt: fxRates.updatedAt })
    .from(fxRates)
    .where(eq(fxRates.currency, 'EUR'))
  if (newest && now - newest.updatedAt.getTime() < FX_TTL_MS) return false
  const rates = await fetchFiatRates(fetch)
  const wanted = new Set<string>(DISPLAY_CURRENCIES)
  const rows = [...rates]
    .filter(([currency]) => wanted.has(currency))
    .map(([currency, perUsd]) => ({ currency, perUsd, updatedAt: new Date(now) }))
  const [first, ...rest] = chunk(rows, 30).map((part) =>
    db
      .insert(fxRates)
      .values(part)
      .onConflictDoUpdate({
        target: fxRates.currency,
        set: { perUsd: sql`excluded.per_usd`, updatedAt: sql`excluded.updated_at` },
      }),
  )
  if (first) await db.batch([first, ...rest])
  return true
}

/** Units of each display currency per USD: fiat from FX rates, BTC/ETH from prices. */
export async function loadRates(db: Db): Promise<RatesResponse> {
  const rates: RatesResponse = { USD: 1 }
  for (const row of await db.select().from(fxRates)) {
    const currency = DISPLAY_CURRENCIES.find((code) => code === row.currency)
    if (currency) rates[currency] = row.perUsd
  }
  const quotes = await loadQuotes(db, Object.values(CRYPTO_CURRENCIES))
  const btc = quotes.get(CRYPTO_CURRENCIES.BTC)?.priceUsd
  const eth = quotes.get(CRYPTO_CURRENCIES.ETH)?.priceUsd
  if (btc) rates.BTC = 1 / btc
  if (eth) rates.ETH = 1 / eth
  return rates
}

/** Run at the end of a user's sync: price what they hold, refresh FX when due. */
export async function priceUser(
  db: Db,
  fetch: typeof globalThis.fetch,
  userId: string,
  now: number,
) {
  await refreshPrices(db, fetch, await assetIdsOf(db, userId), now)
  await refreshFx(db, fetch, now)
}
