import { readFileSync } from 'node:fs'

import { manual } from '@folio/sources'
import { fixtureFetch } from '@folio/sources/testing'
import { afterEach, expect, test } from 'vitest'

import { getDb } from '../src/db'
import { PRICE_TTL_MS, loadQuotes } from '../src/pricing/store'
import { createTestApp } from './app'

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))

let t: Awaited<ReturnType<typeof createTestApp>>
afterEach(() => t.dispose())

const upstream = fixtureFetch([
  { url: 'coins.llama.fi/prices/current/', json: fixture('defillama-prices') },
  { url: 'coins.llama.fi/percentage/', json: fixture('defillama-percentage') },
  { url: 'api.frankfurter.dev', json: fixture('frankfurter-latest') },
])

async function syncManual() {
  t = await createTestApp({}, { sources: [manual], fetch: upstream.fetch, pricing: true })
  const { headers, user } = await t.signIn()
  await t.send('POST', '/api/connections', headers, {
    sourceId: 'manual',
    config: {
      holdings: [
        { assetId: 'coingecko:bitcoin', symbol: 'BTC', amount: '0.5' },
        {
          assetId: 'solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          symbol: 'USDC',
          amount: '10',
        },
      ],
    },
  })
  await t.send('POST', '/api/sync', headers, {})
  await t.runners.runAlarms(user.id)
  return { headers, user }
}

test('a finished sync prices held assets (canonical ids) and BTC/ETH, and fetches FX', async () => {
  upstream.requests.length = 0
  const { headers } = await syncManual()
  const quotes = await loadQuotes(getDb(t.env.DB), [
    'coingecko:bitcoin',
    'coingecko:ethereum',
    'coingecko:usd-coin',
  ])
  expect(quotes.get('coingecko:bitcoin')?.priceUsd).toBeGreaterThan(1000)
  expect(quotes.has('coingecko:ethereum')).toBe(true)
  const priceUrl = upstream.requests.find((r) => r.url.includes('/prices/current/'))?.url ?? ''
  expect(decodeURIComponent(priceUrl)).toContain('coingecko:usd-coin')

  const rates = (await (await t.send('GET', '/api/rates', headers)).json()) as Record<
    string,
    number
  >
  expect(rates['USD']).toBe(1)
  expect(rates['EUR']).toBeGreaterThan(0.5)
  expect(rates['BTC']).toBeCloseTo(1 / 77395.2478594337, 12)
})

test('fresh prices and FX are not fetched again', async () => {
  const { headers, user } = await syncManual()
  upstream.requests.length = 0
  t.clock.now += PRICE_TTL_MS / 2
  await t.send('POST', '/api/sync', headers, {})
  await t.runners.runAlarms(user.id)
  expect(upstream.requests).toEqual([])

  t.clock.now += PRICE_TTL_MS
  await t.send('POST', '/api/sync', headers, {})
  await t.runners.runAlarms(user.id)
  expect(upstream.requests.map((r) => new URL(r.url).host)).toEqual([
    'coins.llama.fi',
    'coins.llama.fi',
  ])
})

test('display currency is saved per user', async () => {
  t = await createTestApp()
  const alice = await t.signIn('Alice')
  const bob = await t.signIn('Bob')
  expect(await (await t.send('GET', '/api/settings', alice.headers)).json()).toEqual({
    currency: 'USD',
    dustUsd: 1,
  })
  const saved = await t.send('PUT', '/api/settings', alice.headers, { currency: 'BTC', dustUsd: 5 })
  expect(saved.status).toBe(200)
  expect(await (await t.send('GET', '/api/settings', alice.headers)).json()).toEqual({
    currency: 'BTC',
    dustUsd: 5,
  })
  expect(await (await t.send('GET', '/api/settings', bob.headers)).json()).toMatchObject({
    currency: 'USD',
  })
  const bad = await t.send('PUT', '/api/settings', alice.headers, { currency: 'DOGE', dustUsd: 1 })
  expect(bad.status).toBe(400)
})
