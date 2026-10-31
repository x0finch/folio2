import type { Holding, Portfolio } from '@folio/shared'
import { describe, expect, test } from 'vitest'

import { dayHighlights, sortHoldings, splitDust } from '../src/features/portfolio/insights'

const holding = (overrides: Partial<Holding>): Holding => ({
  assetId: 'coingecko:x',
  symbol: 'X',
  name: null,
  logo: null,
  amount: '1',
  priceUsd: 1,
  valueUsd: 1,
  change24h: 0,
  changeUsd24h: 0,
  share: null,
  sources: [],
  ...overrides,
})

const portfolio = (holdings: Holding[]): Portfolio => ({
  totalUsd: 0,
  change24hUsd: 0,
  change24h: null,
  holdings,
  perps: [],
  updatedAt: null,
})

describe('dayHighlights', () => {
  test('best gain, worst loss and the stablecoin share', () => {
    const result = dayHighlights(
      portfolio([
        holding({ symbol: 'BTC', valueUsd: 600, changeUsd24h: 50 }),
        holding({ symbol: 'ETH', valueUsd: 200, changeUsd24h: -20 }),
        holding({ symbol: 'USDC', assetId: 'coingecko:usd-coin', valueUsd: 200, changeUsd24h: 0 }),
      ]),
    )
    expect(result.top?.symbol).toBe('BTC')
    expect(result.worst?.symbol).toBe('ETH')
    expect(result.stableShare).toBeCloseTo(0.2)
  })

  test('no gainers means no top, no losers means no worst', () => {
    const result = dayHighlights(portfolio([holding({ changeUsd24h: 5 })]))
    expect(result.top?.symbol).toBe('X')
    expect(result.worst).toBeNull()
    expect(dayHighlights(portfolio([])).stableShare).toBeNull()
  })
})

describe('sortHoldings', () => {
  const list = [
    holding({ symbol: 'B', valueUsd: 10, change24h: 0.5 }),
    holding({ symbol: 'A', valueUsd: null, change24h: null }),
    holding({ symbol: 'C', valueUsd: 30, change24h: -0.1 }),
  ]
  test.each([
    ['value', ['C', 'B', 'A']],
    ['change', ['B', 'C', 'A']],
    ['name', ['A', 'B', 'C']],
  ] as const)('by %s', (sort, expected) => {
    expect(sortHoldings(list, sort).map((h) => h.symbol)).toEqual(expected)
  })
})

test('dust: below the threshold or without a value', () => {
  const { visible, dust } = splitDust(
    [
      holding({ symbol: 'BIG', valueUsd: 5 }),
      holding({ symbol: 'TINY', valueUsd: 0.2 }),
      holding({ symbol: 'NONE', valueUsd: null }),
    ],
    1,
  )
  expect(visible.map((h) => h.symbol)).toEqual(['BIG'])
  expect(dust.map((h) => h.symbol)).toEqual(['TINY', 'NONE'])
})
