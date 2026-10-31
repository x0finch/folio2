import type { Portfolio } from '@folio/shared'
import { expect, test } from 'vitest'

import { byAccount, topSlices } from '../src/features/history/allocation'

test('keeps the top slices and folds the rest into Other', () => {
  const slices = [5, 40, 1, 30, 20, -3].map((value, i) => ({
    id: `a${i}`,
    name: `A${i}`,
    valueUsd: value,
  }))
  expect(topSlices(slices, 3).map((s) => [s.name, s.valueUsd])).toEqual([
    ['A1', 40],
    ['A3', 30],
    ['A4', 20],
    ['Other', 6],
  ])
  // One leftover slice is shown as itself rather than as "Other".
  expect(topSlices(slices.slice(0, 4), 3).map((s) => s.name)).toEqual(['A1', 'A3', 'A0', 'A2'])
})

test('values per account include perp equity', () => {
  const portfolio: Portfolio = {
    totalUsd: 0,
    change24hUsd: 0,
    change24h: null,
    updatedAt: null,
    holdings: [
      {
        assetId: 'coingecko:bitcoin',
        symbol: 'BTC',
        name: null,
        logo: null,
        amount: '1',
        priceUsd: 1,
        valueUsd: 30,
        change24h: null,
        changeUsd24h: null,
        share: null,
        sources: [
          { connectionId: 'a', kind: 'spot', location: null, amount: '1', valueUsd: 10 },
          { connectionId: 'b', kind: 'spot', location: null, amount: '2', valueUsd: 20 },
        ],
      },
    ],
    perps: [
      {
        connectionId: 'b',
        assetId: 'coingecko:ethereum',
        symbol: 'ETH',
        side: 'long',
        size: '1',
        entryPrice: 1,
        markPrice: 1,
        notionalUsd: 100,
        unrealizedPnlUsd: 0,
        equityUsd: 5,
        leverage: null,
        liquidationPrice: null,
      },
    ],
  }
  expect(byAccount(portfolio, new Map([['a', 'Ledger']]))).toEqual([
    { id: 'a', name: 'Ledger', valueUsd: 10 },
    { id: 'b', name: 'Account', valueUsd: 25 },
  ])
})
