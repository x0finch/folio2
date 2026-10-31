import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { hashPassword, isDerivedKey, verifyPassword } from '../src/password'
import { createTestApp } from './app'

let t: Awaited<ReturnType<typeof createTestApp>>
beforeEach(async () => {
  t = await createTestApp()
})
afterEach(() => t.dispose())

/** What the web app sends instead of the password (a PBKDF2 output in hex). */
const derived = (seed: string) => seed.repeat(64).slice(0, 64)

describe('email and password', () => {
  test('signs up, signs in and reads /api/me', async () => {
    const email = 'alice@example.com'
    const up = await t.send('POST', '/api/auth/sign-up/email', undefined, {
      email,
      password: derived('a'),
      name: '',
    })
    expect(up.status).toBe(200)

    const signIn = await t.send('POST', '/api/auth/sign-in/email', undefined, {
      email,
      password: derived('a'),
    })
    expect(signIn.status).toBe(200)
    const cookie = signIn.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ')

    const me = await t.request('/api/me', { headers: { cookie } })
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ email, name: 'alice' })
  })

  test('refuses a wrong password', async () => {
    await t.send('POST', '/api/auth/sign-up/email', undefined, {
      email: 'bob@example.com',
      password: derived('b'),
      name: 'Bob',
    })
    const res = await t.send('POST', '/api/auth/sign-in/email', undefined, {
      email: 'bob@example.com',
      password: derived('c'),
    })
    expect(res.status).toBe(401)
  })

  test('refuses a raw password: only derived keys are stored', async () => {
    const res = await t.send('POST', '/api/auth/sign-up/email', undefined, {
      email: 'carol@example.com',
      password: 'hunter2',
      name: 'Carol',
    })
    expect(res.status).toBe(400)
    await expect(hashPassword('x'.repeat(64))).rejects.toThrow('Expected a derived password key')
  })
})

describe('sessions', () => {
  test('unauthenticated requests get 401', async () => {
    const res = await t.request('/api/me')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  test('the cookie cache answers without touching D1', async () => {
    const { headers } = await t.signIn()
    t.queries.count = 0
    const res = await t.request('/api/me', { headers })
    expect(res.status).toBe(200)
    expect(t.queries.count).toBe(0)
  })
})

describe('password hashing', () => {
  test('verifies only the same derived key', async () => {
    const hash = await hashPassword(derived('d'))
    expect(isDerivedKey(derived('d'))).toBe(true)
    expect(await verifyPassword({ hash, password: derived('d') })).toBe(true)
    expect(await verifyPassword({ hash, password: derived('e') })).toBe(false)
  })
})
