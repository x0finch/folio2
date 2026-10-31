import type { Portfolio } from '@folio/shared'
import { canonicalAssetId } from '@folio/sources'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'

import { getDb } from '../db'
import { positions } from '../db/schema'
import { aggregate } from '../pricing/aggregate'
import { loadQuotes } from '../pricing/store'
import type { AppEnv } from '../types'

export const portfolioRoutes = new Hono<AppEnv>().get('/', async (c) => {
  const db = getDb(c.env.DB)
  const rows = await db
    .select()
    .from(positions)
    .where(eq(positions.userId, c.get('user').id))
  const quotes = await loadQuotes(db, [
    ...new Set(rows.flatMap((row) => [row.assetId, canonicalAssetId(row.assetId)])),
  ])
  return c.json<Portfolio>(
    aggregate(
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
    ),
  )
})
