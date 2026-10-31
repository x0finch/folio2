import type { HistoryRange } from '@folio/shared'
import { canonicalAssetId } from '@folio/sources'
import { and, asc, eq, gte, sql } from 'drizzle-orm'

import type { Db } from '../db'
import { assetSnapshots, portfolioSnapshots, positions } from '../db/schema'
import { aggregate } from '../pricing/aggregate'
import { loadQuotes } from '../pricing/store'
import { type Point, downsample } from './downsample'

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** Points sent to a chart. */
export const MAX_POINTS = 120

export const RANGE_MS: Record<HistoryRange, number | null> = {
  '7d': 7 * DAY,
  '30d': 30 * DAY,
  '90d': 90 * DAY,
  '1y': 365 * DAY,
  all: null,
}

/** The user's portfolio now, from stored positions and prices. */
export async function currentPortfolio(db: Db, userId: string) {
  const rows = await db.select().from(positions).where(eq(positions.userId, userId))
  const quotes = await loadQuotes(db, [
    ...new Set(rows.flatMap((row) => [row.assetId, canonicalAssetId(row.assetId)])),
  ])
  return aggregate(
    rows.map((row) => ({
      connectionId: row.connectionId,
      assetId: row.assetId,
      symbol: row.symbol,
      name: row.name,
      logo: row.logo,
      amount: row.amount,
      kind: row.kind,
      location: row.location,
      priceUsd: row.priceUsd,
      valueUsd: row.valueUsd,
      perp: row.perp,
      updatedAt: row.updatedAt.getTime(),
    })),
    quotes,
  )
}

function chunk<T>(items: T[], size: number): T[][] {
  const parts: T[][] = []
  for (let i = 0; i < items.length; i += size) parts.push(items.slice(i, i + size))
  return parts
}

/** Records this hour's total and today's per-asset values. Repeats overwrite, never add. */
export async function writeSnapshot(db: Db, userId: string, now: number) {
  const portfolio = await currentPortfolio(db, userId)
  const hour = now - (now % HOUR)
  const day = now - (now % DAY)
  const assets = portfolio.holdings.map((holding) => ({
    userId,
    day,
    assetId: holding.assetId,
    amount: holding.amount,
    valueUsd: holding.valueUsd,
  }))
  for (const perp of portfolio.perps) {
    // Perp equity per asset, so an asset's history includes it.
    assets.push({ userId, day, assetId: perp.assetId, amount: '0', valueUsd: perp.equityUsd })
  }
  await db.batch([
    db
      .insert(portfolioSnapshots)
      .values({ userId, hour, totalUsd: portfolio.totalUsd })
      .onConflictDoUpdate({
        target: [portfolioSnapshots.userId, portfolioSnapshots.hour],
        set: { totalUsd: sql`excluded.total_usd` },
      }),
    // Assets no longer held today should not linger in today's row set.
    db
      .delete(assetSnapshots)
      .where(and(eq(assetSnapshots.userId, userId), eq(assetSnapshots.day, day))),
    // 5 columns per row: 15 rows per statement stays under D1's parameter limit.
    ...chunk(dedupe(assets), 15).map((part) => db.insert(assetSnapshots).values(part)),
  ])
}

/** Perp equity and a spot holding of the same asset share a row: values add, spot amount wins. */
function dedupe<T extends { assetId: string; amount: string; valueUsd: number | null }>(rows: T[]) {
  const byAsset = new Map<string, T>()
  for (const row of rows) {
    const seen = byAsset.get(row.assetId)
    if (!seen) byAsset.set(row.assetId, { ...row })
    else seen.valueUsd = (seen.valueUsd ?? 0) + (row.valueUsd ?? 0)
  }
  return [...byAsset.values()]
}

export async function portfolioHistory(db: Db, userId: string, range: HistoryRange, now: number) {
  const span = RANGE_MS[range]
  const rows = await db
    .select({ t: portfolioSnapshots.hour, v: portfolioSnapshots.totalUsd })
    .from(portfolioSnapshots)
    .where(
      and(
        eq(portfolioSnapshots.userId, userId),
        span === null ? undefined : gte(portfolioSnapshots.hour, now - span),
      ),
    )
    .orderBy(asc(portfolioSnapshots.hour))
  return downsample(rows, MAX_POINTS)
}

export async function assetHistory(
  db: Db,
  userId: string,
  assetId: string,
  range: HistoryRange,
  now: number,
): Promise<Point[]> {
  const span = RANGE_MS[range]
  const rows = await db
    .select({ t: assetSnapshots.day, v: assetSnapshots.valueUsd })
    .from(assetSnapshots)
    .where(
      and(
        eq(assetSnapshots.userId, userId),
        eq(assetSnapshots.assetId, assetId),
        span === null ? undefined : gte(assetSnapshots.day, now - span),
      ),
    )
    .orderBy(asc(assetSnapshots.day))
  return downsample(
    rows.map((row) => ({ t: row.t, v: row.v ?? 0 })),
    MAX_POINTS,
  )
}
