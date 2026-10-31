import { readFileSync } from 'node:fs'

import { fixtureFetch } from '@folio/sources/testing'
import { expect, test } from 'vitest'

import { searchAssets } from '../src/routes/assets'

test('maps CoinGecko search results to pickable assets', async () => {
  const json: unknown = JSON.parse(
    readFileSync(new URL('./fixtures/coingecko-search.json', import.meta.url), 'utf8'),
  )
  const { fetch, requests } = fixtureFetch([{ url: 'api.coingecko.com/api/v3/search', json }])
  const results = await searchAssets(fetch, 'bitc')
  expect(results[0]).toMatchObject({
    assetId: 'coingecko:bitcoin',
    symbol: 'BTC',
    name: 'Bitcoin',
    rank: 1,
  })
  expect(results[0]?.logo).toMatch(/^https:\/\//)
  expect(results.length).toBeLessThanOrEqual(12)
  expect(requests[0]?.url).toContain('query=bitc')
})
