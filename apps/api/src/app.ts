import type { HealthResponse } from '@folio/shared'
import { Hono } from 'hono'

import type { AppEnv } from './types'

export function createApp() {
  const app = new Hono<AppEnv>().basePath('/api')

  app.get('/health', async (c) => {
    // Touch D1 so the check covers the binding, not just the Worker.
    await c.env.DB.prepare('select 1').first()
    return c.json<HealthResponse>({ ok: true })
  })

  return app
}
