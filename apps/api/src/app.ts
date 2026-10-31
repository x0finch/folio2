import type { HealthResponse, MeResponse } from '@folio/shared'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'

import { getAuth } from './auth'
import { errorResponse, fail } from './http'
import { requireUser } from './middleware'
import { authRateLimit } from './rate-limit'
import type { AppEnv, AuthFor } from './types'

/** Request bodies above this are refused before they are read in full. */
const MAX_BODY_BYTES = 256 * 1024

export interface AppOptions {
  auth?: AuthFor
}

export function createApp(options: AppOptions = {}) {
  const authFor = options.auth ?? getAuth
  const app = new Hono<AppEnv>().basePath('/api')

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

  app.onError(errorResponse)
  return app
}
