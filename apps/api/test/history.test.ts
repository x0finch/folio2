import { readFileSync } from 'node:fs'

import { manual } from '@folio/sources'
import { fixtureFetch } from '@folio/sources/testing'
import { afterEach, describe, expect, test } from 'vitest'

import { getDb } from '../src/db'
import { type Point, downsample } from '../src/history/downsample'
import { assetHistory, portfolioHistory } from '../src/history/snapshots'
import { createTestApp } from './app'

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))

const series = (n: number): Point[] => Array.from({ length: n }, (_, i) => ({ t: i * 10, v: i }))

describe('downsample', () => {
  test('short series pass through', () => {
    expect(downsample(series(5), 10)).toEqual(series(5))
  })

  test.each([200, 1000, 121])(
    '%i points become at most 120, first and last kept, time increasing',
    (n) => {
      const points = series(n)
      const result = downsample(points, 120)
      expect(result.length).toBeLessThanOrEqual(120)
      expect(result[0]).toEqual(points[0])
      expect(result.at(-1)).toEqual(points.at(-1))
      for (let i = 1; i < result.length; i += 1)
        expect(result[i]!.t).toBeGreaterThan(result[i - 1]!.t)
    },
  )
})

describe('snapshots', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>
  afterEach(() => t.dispose())

  const upstream = fixtureFetch([
    { url: 'coins.llama.fi/prices/current/', json: fixture('defillama-prices') },
    { url: 'coins.llama.fi/percentage/', json: fixture('defillama-percentage') },
    { url: 'api.frankfurter.dev', json: fixture('frankfurter-latest') },
  ])

  async function setup() {
    t = await createTestApp({}, { sources: [manual], fetch: upstream.fetch, pricing: true })
    const { headers, user } = await t.signIn()
    const res = await t.send('POST', '/api/connections', headers, {
      sourceId: 'manual',
      config: { holdings: [{ assetId: 'coingecko:bitcoin', symbol: 'BTC', amount: '1' }] },
    })
    const { id }: { id: string } = await res.json()
    const sync = async () => {
      await t.send('POST', '/api/sync', headers, {})
      await t.runners.runAlarms(user.id)
    }
    return { headers, user, id, sync }
  }

  test('repeated syncs in one hour overwrite instead of adding rows', async () => {
    const { user, sync } = await setup()
    await sync()
    t.clock.now += 10 * 60_000
    await sync()
    const points = await portfolioHistory(getDb(t.env.DB), user.id, 'all', t.clock.now)
    expect(points).toHaveLength(1)
    expect(points[0]?.v).toBeGreaterThan(1000)

    t.clock.now += 60 * 60_000
    await sync()
    expect(await portfolioHistory(getDb(t.env.DB), user.id, 'all', t.clock.now)).toHaveLength(2)
  })

  test('asset history keeps one row per day; ranges cut old points', async () => {
    const { user, sync } = await setup()
    for (let day = 0; day < 10; day += 1) {
      await sync()
      t.clock.now += 24 * 3_600_000
    }
    const db = getDb(t.env.DB)
    const all = await assetHistory(db, user.id, 'coingecko:bitcoin', 'all', t.clock.now)
    expect(all).toHaveLength(10)
    const week = await assetHistory(db, user.id, 'coingecko:bitcoin', '7d', t.clock.now)
    expect(week).toHaveLength(7)
    expect(await portfolioHistory(db, user.id, '7d', t.clock.now)).toHaveLength(7)
  })

  test('the history endpoint answers per user', async () => {
    const { headers, sync } = await setup()
    await sync()
    const res = await t.send('GET', '/api/history?range=all', headers)
    const body: { points: unknown[] } = await res.json()
    expect(body.points).toHaveLength(1)
    const bob = await t.signIn('Bob')
    const other = await t.send('GET', '/api/history?range=all', bob.headers)
    expect(await other.json()).toEqual({ points: [] })
    expect((await t.send('GET', '/api/history?range=5y', headers)).status).toBe(400)
  })
})
