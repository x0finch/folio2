import type { HealthResponse, MeResponse } from '@folio/shared'
import type { Source } from '@folio/sources'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'

import { getAuth } from './auth'
import { errorResponse, fail } from './http'
import { requireUser } from './middleware'
import { authRateLimit } from './rate-limit'
import { assetRoutes } from './routes/assets'
import { connectionRoutes, sourceRoutes } from './routes/connections'
import { historyRoutes } from './routes/history'
import { portfolioRoutes } from './routes/portfolio'
import { rateRoutes, settingsRoutes } from './routes/settings'
import { syncRoutes } from './routes/sync'
import { createRegistry, defaultRegistry } from './sources'
import type { AppEnv, AuthFor } from './types'

/** Request bodies above this are refused before they are read in full. */
const MAX_BODY_BYTES = 256 * 1024

export interface AppOptions {
  auth?: AuthFor
  /** Source plugins; defaults to the registry in @folio/sources. */
  sources?: readonly Source[]
}

export function createApp(options: AppOptions = {}) {
  const authFor = options.auth ?? getAuth
  const sourceRegistry = options.sources ? createRegistry(options.sources) : defaultRegistry
  const app = new Hono<AppEnv>().basePath('/api')

  app.use('*', async (c, next) => {
    c.set('sources', sourceRegistry)
    await next()
  })

  app.use('*', bodyLimit({ maxSize: MAX_BODY_BYTES, onError: () => fail('too_large') }))

  app.get('/health', async (c) => {
    // Touch D1 so the check covers the binding, not just the Worker.
    await c.env.DB.prepare('select 1').first()
    return c.json<HealthResponse>({ ok: true })
  })

  app.use('/auth/*', authRateLimit)
  app.on(['GET', 'POST'], '/auth/*', (c) => authFor(c.env).handler(c.req.raw))

  // Everything below needs a signed-in user.
  app.use('*', requireUser(authFor))

  app.get('/me', (c) => {
    const user = c.get('user')
    return c.json<MeResponse>({ id: user.id, email: user.email, name: user.name })
  })

  app.route('/sources', sourceRoutes)
  app.route('/connections', connectionRoutes)
  app.route('/sync', syncRoutes)
  app.route('/settings', settingsRoutes)
  app.route('/rates', rateRoutes)
  app.route('/portfolio', portfolioRoutes)
  app.route('/assets', assetRoutes)
  app.route('/history', historyRoutes)

  app.onError(errorResponse)
  return app
}
