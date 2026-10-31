import { HISTORY_RANGES, type HistoryResponse } from '@folio/shared'
import { Hono } from 'hono'
import { z } from 'zod'

import { getDb } from '../db'
import { assetHistory, portfolioHistory } from '../history/snapshots'
import { query } from '../http'
import type { AppEnv } from '../types'

const rangeQuery = z.object({ range: z.enum(HISTORY_RANGES).default('30d') })

export const historyRoutes = new Hono<AppEnv>()
  .get('/', query(rangeQuery), async (c) => {
    const { range } = c.req.valid('query')
    const points = await portfolioHistory(getDb(c.env.DB), c.get('user').id, range, Date.now())
    return c.json<HistoryResponse>({ points })
  })
  .get('/assets/:assetId', query(rangeQuery), async (c) => {
    const { range } = c.req.valid('query')
    const points = await assetHistory(
      getDb(c.env.DB),
      c.get('user').id,
      c.req.param('assetId'),
      range,
      Date.now(),
    )
    return c.json<HistoryResponse>({ points })
  })
