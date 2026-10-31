import { expect, test } from 'vitest'

import { manual } from '../src/manual'
import { contextFor, fixtureFetch } from '../src/testing'

test('turns holdings into spot positions without any request', async () => {
  const { fetch, requests } = fixtureFetch([])
  const ctx = contextFor(
    manual,
    {
      holdings: [
        { assetId: 'coingecko:bitcoin', symbol: 'BTC', amount: '0.5', note: 'Ledger' },
        { assetId: 'ethereum:0xa0b8', symbol: 'USDC', amount: '1200' },
      ],
    },
    fetch,
  )
  expect(await manual.fetchPositions(ctx)).toEqual([
    {
      asset: { id: 'coingecko:bitcoin', symbol: 'BTC', name: undefined },
      amount: '0.5',
      kind: 'spot',
      location: 'Ledger',
    },
    {
      asset: { id: 'ethereum:0xa0b8', symbol: 'USDC', name: undefined },
      amount: '1200',
      kind: 'spot',
      location: undefined,
    },
  ])
  expect(requests).toHaveLength(0)
})

test('rejects amounts that are not plain decimals', () => {
  const parsed = manual.config.safeParse({
    holdings: [{ assetId: 'coingecko:bitcoin', symbol: 'BTC', amount: '1e3' }],
  })
  expect(parsed.success).toBe(false)
})
