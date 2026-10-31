import { readFileSync } from 'node:fs'

import { fixtureFetch } from '@folio/sources/testing'
import { expect, test } from 'vitest'

import { DEFILLAMA_BATCH, fetchQuotes } from '../src/pricing/defillama'
import { fetchFiatRates } from '../src/pricing/frankfurter'

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))

test('DefiLlama quotes: price, 24h change as a ratio, unknown ids absent', async () => {
  const { fetch, requests } = fixtureFetch([
    { url: '/prices/current/', json: fixture('defillama-prices') },
    { url: '/percentage/', json: fixture('defillama-percentage') },
  ])
  const quotes = await fetchQuotes(fetch, [
    'coingecko:bitcoin',
    'ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    'coingecko:not-a-coin',
  ])
  expect(quotes.get('coingecko:bitcoin')?.priceUsd).toBeCloseTo(77395.25, 2)
  expect(quotes.get('coingecko:bitcoin')?.change24h).toBeCloseTo(-0.0022356, 7)
  expect(quotes.get('ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')?.priceUsd).toBeCloseTo(
    1,
    2,
  )
  expect(quotes.has('coingecko:not-a-coin')).toBe(false)
  expect(requests).toHaveLength(2)
})

test('DefiLlama drops low-confidence prices and batches long lists', async () => {
  const { fetch, requests } = fixtureFetch([
    {
      url: '/prices/current/',
      json: {
        coins: {
          'coingecko:bitcoin': { price: 1, confidence: 0.99, timestamp: 1 },
          'base:0xscam': { price: 1000, confidence: 0.2, timestamp: 1 },
        },
      },
    },
    { url: '/percentage/', json: { coins: {} } },
  ])
  const ids = [
    'coingecko:bitcoin',
    'base:0xscam',
    ...Array.from({ length: DEFILLAMA_BATCH }, (_, i) => `base:0x${i}`),
  ]
  const quotes = await fetchQuotes(fetch, ids)
  expect(quotes.has('base:0xscam')).toBe(false)
  expect(quotes.get('coingecko:bitcoin')).toEqual({ priceUsd: 1, change24h: null })
  expect(requests).toHaveLength(4)
})

test('Frankfurter rates per USD include USD itself', async () => {
  const { fetch } = fixtureFetch([{ url: 'frankfurter', json: fixture('frankfurter-latest') }])
  const rates = await fetchFiatRates(fetch)
  expect(rates.get('USD')).toBe(1)
  expect(rates.get('EUR')).toBeGreaterThan(0.5)
  expect(rates.get('JPY')).toBeGreaterThan(50)
})
