import { DEFAULT_SETTINGS, type RatesResponse, type Settings, settingsSchema } from '@folio/shared'
import { eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'

import { getDb } from '../db'
import { userSettings } from '../db/schema'
import { json } from '../http'
import { loadRates } from '../pricing/store'
import type { AppEnv } from '../types'

export const settingsRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const [row] = await getDb(c.env.DB)
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, c.get('user').id))
    const parsed = settingsSchema.safeParse(row ?? {})
    return c.json<Settings>(parsed.success ? parsed.data : DEFAULT_SETTINGS)
  })
  .put('/', json(settingsSchema), async (c) => {
    const settings = c.req.valid('json')
    await getDb(c.env.DB)
      .insert(userSettings)
      .values({ userId: c.get('user').id, ...settings, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: userSettings.userId,
        set: {
          currency: sql`excluded.currency`,
          dustUsd: sql`excluded.dust_usd`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
    return c.json<Settings>(settings)
  })

export const rateRoutes = new Hono<AppEnv>().get('/', async (c) =>
  c.json<RatesResponse>(await loadRates(getDb(c.env.DB))),
)
