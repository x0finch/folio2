import { describe, expect, test } from 'vitest'

import { type PositionInput, aggregate } from '../src/pricing/aggregate'
import type { Quote } from '../src/pricing/defillama'

const USDC_ETH = 'ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const USDC_SOL = 'solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

const position = (overrides: Partial<PositionInput>): PositionInput => ({
  connectionId: 'c1',
  assetId: 'coingecko:bitcoin',
  symbol: 'BTC',
  name: null,
  logo: null,
  amount: '1',
  kind: 'spot',
  location: null,
  priceUsd: null,
  valueUsd: null,
  perp: null,
  updatedAt: 1000,
  ...overrides,
})

const quotes = new Map<string, Quote>([
  ['coingecko:bitcoin', { priceUsd: 100_000, change24h: 0.1 }],
  ['coingecko:usd-coin', { priceUsd: 1, change24h: 0 }],
  ['coingecko:ethereum', { priceUsd: 2000, change24h: -0.5 }],
])

describe('aggregate', () => {
  test('merges the same asset across connections and chains', () => {
    const portfolio = aggregate(
      [
        position({ connectionId: 'a', amount: '0.5' }),
        position({ connectionId: 'b', amount: '0.25', kind: 'staked' }),
        position({ connectionId: 'a', assetId: USDC_ETH, symbol: 'USDC', amount: '100' }),
        position({ connectionId: 'c', assetId: USDC_SOL, symbol: 'usdc', amount: '50.5' }),
      ],
      quotes,
    )
    expect(portfolio.holdings.map((h) => [h.assetId, h.amount, h.valueUsd])).toEqual([
      ['coingecko:bitcoin', '0.75', 75_000],
      ['coingecko:usd-coin', '150.5', 150.5],
    ])
    expect(portfolio.holdings[1]?.symbol).toBe('USDC')
    expect(portfolio.holdings[0]?.sources).toHaveLength(2)
    expect(portfolio.totalUsd).toBe(75_150.5)
  })

  test('decimal amounts add up exactly', () => {
    const portfolio = aggregate(
      [position({ amount: '0.1' }), position({ amount: '0.2' })],
      new Map(),
    )
    expect(portfolio.holdings[0]?.amount).toBe('0.3')
  })

  test('feed prices win over venue prices; venue prices fill gaps', () => {
    const portfolio = aggregate(
      [
        position({ amount: '1', priceUsd: 1 }),
        position({ assetId: 'base:0xnew', symbol: 'NEW', amount: '10', priceUsd: 2 }),
      ],
      quotes,
    )
    expect(portfolio.holdings.find((h) => h.symbol === 'BTC')?.priceUsd).toBe(100_000)
    expect(portfolio.holdings.find((h) => h.symbol === 'NEW')?.valueUsd).toBe(20)
  })

  test('unknown prices keep the amount without a value', () => {
    const portfolio = aggregate([position({ assetId: 'base:0xunknown', symbol: 'X' })], quotes)
    expect(portfolio.holdings[0]).toMatchObject({ amount: '1', valueUsd: null, share: null })
    expect(portfolio.totalUsd).toBe(0)
  })

  test('borrowed counts negative', () => {
    const portfolio = aggregate(
      [
        position({ assetId: 'coingecko:ethereum', symbol: 'ETH', amount: '2' }),
        position({ assetId: 'coingecko:ethereum', symbol: 'ETH', amount: '0.5', kind: 'borrowed' }),
      ],
      quotes,
    )
    expect(portfolio.holdings[0]).toMatchObject({ amount: '1.5', valueUsd: 3000 })
  })

  test('24h changes add up to the total change', () => {
    const portfolio = aggregate(
      [
        position({ amount: '1' }),
        position({ assetId: 'coingecko:ethereum', symbol: 'ETH', amount: '10' }),
      ],
      quotes,
    )
    // BTC: 100k now, was 100k/1.1; ETH: 20k now, was 40k.
    const btcChange = 100_000 - 100_000 / 1.1
    const ethChange = 20_000 - 40_000
    expect(portfolio.holdings.find((h) => h.symbol === 'BTC')?.changeUsd24h).toBeCloseTo(btcChange)
    expect(portfolio.change24hUsd).toBeCloseTo(btcChange + ethChange)
    const sum = portfolio.holdings.reduce((total, h) => total + (h.changeUsd24h ?? 0), 0)
    expect(sum).toBeCloseTo(portfolio.change24hUsd)
    expect(portfolio.change24h).toBeCloseTo(
      portfolio.change24hUsd / (portfolio.totalUsd - portfolio.change24hUsd),
    )
  })

  test('shares are of the gross positive value and sum to 1', () => {
    const portfolio = aggregate(
      [
        position({ amount: '1' }),
        position({ assetId: 'coingecko:ethereum', symbol: 'ETH', amount: '50' }),
      ],
      quotes,
    )
    const shares = portfolio.holdings.map((h) => h.share ?? 0)
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
    expect(portfolio.holdings[0]?.share).toBeCloseTo(0.5)
  })

  test('perps count their equity, not notional, and are listed apart', () => {
    const portfolio = aggregate(
      [
        position({ amount: '1' }),
        position({
          connectionId: 'hl',
          assetId: 'coingecko:ethereum',
          symbol: 'ETH',
          amount: '5',
          kind: 'perp',
          perp: {
            side: 'long',
            size: '5',
            entryPrice: 1800,
            markPrice: 2000,
            unrealizedPnlUsd: 1000,
            marginUsd: 2000,
            leverage: 5,
          },
        }),
      ],
      quotes,
    )
    expect(portfolio.holdings).toHaveLength(1)
    expect(portfolio.perps[0]).toMatchObject({
      symbol: 'ETH',
      notionalUsd: 10_000,
      equityUsd: 3000,
      leverage: 5,
    })
    expect(portfolio.totalUsd).toBe(103_000)
  })
})
