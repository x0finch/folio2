import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { betterAuth } from 'better-auth/minimal'
import { drizzle } from 'drizzle-orm/d1'

// Only Better Auth's own tables; the app's tables are queried separately.
import * as schema from './db/auth-schema'
import type { Env } from './env'
import { newId } from './ids'
import { hashPassword, verifyPassword } from './password'

/** The app origin plus other origins serving the same app (e.g. workers.dev next to a domain). */
export function trustedOrigins(env: Env): string[] {
  const extra = (env.TRUSTED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean)
  return [env.BETTER_AUTH_URL, ...extra]
}

/**
 * Better Auth configured for the Workers free plan (10ms CPU per request):
 * - `better-auth/minimal` (no Kysely), no plugins, to keep the bundle small
 * - signed cookie cache (compact HMAC, not JWE) so most requests validate the session
 *   without a D1 read, and a long `updateAge` so sessions are rarely rewritten
 * - email/password without scrypt: the app stretches passwords and the server stores a
 *   salted SHA-256 of the result (password.ts)
 * - no DB-backed rate limiting: Workers rate limiters guard the auth endpoints (rate-limit.ts)
 */
export function createAuthOptions(env: Env) {
  return {
    baseURL: env.BETTER_AUTH_URL,
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(drizzle(env.DB, { schema }), { provider: 'sqlite', schema }),
    emailAndPassword: {
      enabled: true,
      // The app sends a 64-hex-character derived key, never the password itself.
      minPasswordLength: 64,
      maxPasswordLength: 64,
      password: { hash: hashPassword, verify: verifyPassword },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 60,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: true, maxAge: 5 * 60, strategy: 'compact' as const },
    },
    rateLimit: { enabled: false },
    telemetry: { enabled: false },
    trustedOrigins: trustedOrigins(env),
    advanced: { database: { generateId: () => newId() } },
    databaseHooks: {
      user: {
        create: {
          // Email sign-up has no profile name; start with the address's local part.
          before: async (user: { name?: string | null; email: string }) => ({
            data: { ...user, name: user.name?.trim() || user.email.split('@')[0] || user.email },
          }),
        },
      },
    },
    plugins: [],
  }
}

export function createAuth(env: Env) {
  return betterAuth(createAuthOptions(env))
}

export type Auth = ReturnType<typeof createAuth>

// One instance per isolate: building the instance is pure CPU, and the env object is
// stable for the lifetime of the isolate.
const instances = new WeakMap<Env, Auth>()

export function getAuth(env: Env): Auth {
  let auth = instances.get(env)
  if (!auth) {
    auth = createAuth(env)
    instances.set(env, auth)
  }
  return auth
}
