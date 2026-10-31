import { manual } from '@folio/sources'
import { afterEach, expect, test } from 'vitest'

import { createTestApp } from './app'

let t: Awaited<ReturnType<typeof createTestApp>>
afterEach(() => t.dispose())

const USER_TABLES = [
  'session',
  'account',
  'connections',
  'positions',
  'user_settings',
  'portfolio_snapshots',
  'asset_snapshots',
]

test('deleting the account removes every row of that user and nobody else', async () => {
  t = await createTestApp({}, { sources: [manual], fetch: async () => Response.json({}) })
  const alice = await t.signIn('Alice')
  const bob = await t.signIn('Bob')
  for (const { headers, user } of [alice, bob]) {
    await t.send('POST', '/api/connections', headers, {
      sourceId: 'manual',
      config: { holdings: [{ assetId: 'coingecko:bitcoin', symbol: 'BTC', amount: '1' }] },
    })
    await t.send('PUT', '/api/settings', headers, { currency: 'EUR', dustUsd: 1 })
    await t.send('POST', '/api/sync', headers, {})
    await t.runners.runAlarms(user.id)
    await t.env.DB.batch([
      t.env.DB.prepare('insert into portfolio_snapshots values (?, 0, 1)').bind(user.id),
      t.env.DB.prepare(
        "insert into asset_snapshots values (?, 0, 'coingecko:bitcoin', '1', 1)",
      ).bind(user.id),
    ])
  }

  const res = await t.send('DELETE', '/api/me', alice.headers)
  expect(res.status).toBe(204)
  expect(res.headers.getSetCookie().join(';')).toContain('Max-Age=0')

  const count = async (table: string, userId: string) => {
    const column = table === 'user' ? 'id' : 'user_id'
    const row = await t.env.DB.prepare(`select count(*) as n from ${table} where ${column} = ?`)
      .bind(userId)
      .first<{ n: number }>()
    return row?.n
  }
  expect(await count('user', alice.user.id)).toBe(0)
  const left = Object.fromEntries(
    await Promise.all(USER_TABLES.map(async (table) => [table, await count(table, alice.user.id)])),
  )
  expect(left).toEqual(Object.fromEntries(USER_TABLES.map((table) => [table, 0])))
  // Bob keeps everything (he has no password account row: test users sign in by session only).
  const kept = await Promise.all(
    USER_TABLES.filter((table) => table !== 'account').map((table) => count(table, bob.user.id)),
  )
  expect(kept.every((n) => (n ?? 0) > 0)).toBe(true)
  // Without the signed cookie cache (which the response just cleared), the session is gone.
  const sessionOnly = new Headers({
    cookie: (alice.headers.get('cookie') ?? '')
      .split('; ')
      .filter((cookie) => !cookie.includes('session_data'))
      .join('; '),
  })
  expect((await t.send('GET', '/api/me', sessionOnly)).status).toBe(401)
})
