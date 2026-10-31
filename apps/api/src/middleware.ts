import { createMiddleware } from 'hono/factory'

import { fail } from './http'
import type { AppEnv, AuthFor } from './types'

/** Resolves the session from the cookie; most requests hit the signed cookie cache. */
export function requireUser(authFor: AuthFor) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const { headers, response: data } = await authFor(c.env).api.getSession({
      headers: c.req.raw.headers,
      returnHeaders: true,
    })
    if (!data) fail('unauthorized')
    c.set('user', data.user)
    await next()
    // Forward cookie updates (cache refresh, session renewal) so later requests skip D1.
    for (const cookie of headers.getSetCookie()) c.res.headers.append('Set-Cookie', cookie)
    return undefined
  })
}
