import type { Portfolio } from '@folio/shared'
import { Hono } from 'hono'

import { getDb } from '../db'
import { currentPortfolio } from '../history/snapshots'
import type { AppEnv } from '../types'

export const portfolioRoutes = new Hono<AppEnv>().get('/', async (c) =>
  c.json<Portfolio>(await currentPortfolio(getDb(c.env.DB), c.get('user').id)),
)
