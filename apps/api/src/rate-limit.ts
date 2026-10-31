import type { MiddlewareHandler } from 'hono'

import type { AppEnv } from './types'

/** Checks a password: limited per account so passwords cannot be guessed quickly. */
const GUESSES = new Set(['/api/auth/sign-in/email', '/api/auth/change-password'])
/** Limited per IP only. */
const PER_IP = new Set(['/api/auth/sign-up/email'])

async function emailOf(request: Request): Promise<string | undefined> {
  try {
    // Read a copy: Better Auth still needs the original body.
    const body: unknown = await request.clone().json()
    return typeof body === 'object' &&
      body !== null &&
      'email' in body &&
      typeof body.email === 'string'
      ? body.email.trim().toLowerCase()
      : undefined
  } catch {
    return undefined
  }
}

const allowed = { success: true }

/**
 * Rate limits for the auth endpoints, using the Workers rate limiting binding (counted at the
 * edge, no D1 queries): per IP for every sign-in and sign-up, and per account for password
 * checks. Without the binding (tests, local dev) nothing is limited.
 */
export const authRateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = c.req.path
  const guesses = GUESSES.has(path)
  if (c.req.method !== 'POST' || !(guesses || PER_IP.has(path))) return next()

  const limiter = c.env.AUTH_RATE_LIMIT
  if (!limiter) return next()
  const ip = c.req.header('cf-connecting-ip')
  const email = guesses ? await emailOf(c.req.raw) : undefined
  const checks = await Promise.all([
    ip ? limiter.limit({ key: `ip:${ip}` }) : allowed,
    email ? limiter.limit({ key: `account:${email}` }) : allowed,
  ])
  if (checks.some((check) => !check.success)) {
    return c.json({ code: 'TOO_MANY_REQUESTS', message: 'Too many requests' }, 429)
  }
  return next()
}
