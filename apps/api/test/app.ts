import { betterAuth } from 'better-auth/minimal'
import { testUtils } from 'better-auth/plugins'

import { createApp } from '../src/app'
import { createAuthOptions } from '../src/auth'
import type { Env } from '../src/env'
import { createTestDb } from './d1'

export const TEST_ORIGIN = 'http://localhost:8787'

/** App wired to a fresh D1 and a Better Auth instance with test helpers. */
export async function createTestApp(overrides: Partial<Env> = {}) {
  const { db: base, dispose } = await createTestDb()
  // Counts D1 statements so tests can assert which requests touch the database.
  const queries = { count: 0 }
  const db = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'prepare') queries.count += 1
      const value: unknown = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const env: Env = {
    DB: db,
    BETTER_AUTH_URL: TEST_ORIGIN,
    BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-123',
    ENCRYPTION_SECRET: 'test-encryption-secret-test-encryption',
    ...overrides,
  }
  const options = createAuthOptions(env)
  const auth = betterAuth({ ...options, plugins: [...options.plugins, testUtils()] })
  const app = createApp({ auth: () => auth })
  const helpers = (await auth.$context).test

  /** Creates a user and returns request headers carrying their session cookie. */
  async function signIn(name = 'Test User') {
    const user = await helpers.saveUser(
      helpers.createUser({ name, email: `${crypto.randomUUID()}@example.com` }),
    )
    const headers = await helpers.getAuthHeaders({ userId: user.id })
    // Like a real client, keep the cookie cache the first authenticated response sets.
    const res = await app.request(new URL('/api/me', TEST_ORIGIN).toString(), { headers }, env)
    const cache = res.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0])
      .find((cookie) => cookie?.includes('session_data'))
    if (cache) headers.set('cookie', `${headers.get('cookie')}; ${cache}`)
    return { user, headers }
  }

  const request = (path: string, init: RequestInit = {}) =>
    app.request(new URL(path, TEST_ORIGIN).toString(), init, env)

  /** A JSON request as the web app makes it, signed in when `headers` carry a session. */
  const send = (method: string, path: string, headers?: Headers, body?: unknown) =>
    request(path, {
      method,
      headers: {
        ...Object.fromEntries(headers ?? []),
        'Content-Type': 'application/json',
        Origin: TEST_ORIGIN,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  return { app, env, auth, request, send, signIn, queries, dispose }
}
