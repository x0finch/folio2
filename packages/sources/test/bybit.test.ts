import { describe, expect, test } from 'vitest'

import { bybit } from '../src/bybit'
import { signBybit } from '../src/bybit/sign'
import { SourceError } from '../src/errors'
import { contextFor, fixtureFetch, type FixtureRoute } from '../src/testing'
import error10003 from './fixtures/bybit/error-10003.json'
import error10004 from './fixtures/bybit/error-10004.json'
import error10006 from './fixtures/bybit/error-10006.json'
import error10010 from './fixtures/bybit/error-10010.json'
import fundBalance from './fixtures/bybit/fund-balance.json'
import tickers from './fixtures/bybit/market-tickers.json'
import walletBalance from './fixtures/bybit/wallet-balance.json'

const config = { apiKey: 'XXXXXXXXXX', apiSecret: 'kHq4wP2sV9mZr7TnL3cXb8YdF6gJ1uEa' }

const routes: FixtureRoute[] = [
  { url: '/v5/account/wallet-balance?accountType=UNIFIED', json: walletBalance },
  { url: '/v5/asset/transfer/query-account-coins-balance?accountType=FUND', json: fundBalance },
  { url: '/v5/market/tickers?category=spot', json: tickers },
]

describe('signing', () => {
  test('signs timestamp + apiKey + recvWindow + queryString as hex HMAC-SHA256', async () => {
    // The GET example of Bybit's v5 "Integration guidance". Bybit publishes the string to sign
    // but not the secret behind its example signature, so the secret here is 'XXXXXXXXXX' and
    // the expected value was computed independently with Node's `createHmac`.
    const input = {
      timestamp: 1658384314791,
      apiKey: 'XXXXXXXXXX',
      recvWindow: 5000,
      payload: 'category=option&symbol=BTC-29JUL22-25000-C',
    }
    expect(await signBybit(input, 'XXXXXXXXXX')).toBe(
      'c00720f96c5934ca7057ac28ae65b823f83b8b67a8fe784e7795ca0fa3c148ec',
    )
  })
})

describe('bybit', () => {
  test('reads unified and funding balances', async () => {
    const { fetch, requests } = fixtureFetch(routes)
    const ctx = contextFor(bybit, config, fetch)
    expect(await bybit.fetchPositions(ctx)).toEqual([
      // The all-zero BTC row of the docs example is dropped.
      {
        asset: { id: 'coingecko:ethereum', symbol: 'ETH' },
        amount: '1.5',
        kind: 'spot',
        location: 'unified',
        priceUsd: expect.closeTo(2243.97, 2),
      },
      {
        asset: { id: 'coingecko:tether', symbol: 'USDT' },
        amount: '250.25',
        kind: 'spot',
        location: 'unified',
        priceUsd: expect.closeTo(0.9992, 4),
      },
      {
        asset: { id: 'coingecko:mantle', symbol: 'MNT' },
        amount: '20',
        kind: 'borrowed',
        location: 'unified',
        priceUsd: 0.475,
      },
      {
        asset: { id: 'cex:PEOPLE', symbol: 'PEOPLE' },
        amount: '1000',
        kind: 'spot',
        location: 'unified',
        priceUsd: 0.00623,
      },
      {
        asset: { id: 'coingecko:tether', symbol: 'USDT' },
        amount: '100',
        kind: 'spot',
        location: 'funding',
        priceUsd: expect.closeTo(0.9992, 4),
      },
      {
        asset: { id: 'cex:ORDI', symbol: 'ORDI' },
        amount: '5',
        kind: 'spot',
        location: 'funding',
        priceUsd: 31.2,
      },
    ])
    expect(ctx.fetch.budget.used).toBe(3)
    expect(ctx.fetch.budget.used).toBeLessThanOrEqual(bybit.maxRequests(ctx.config))
    expect(bybit.maxRequests(ctx.config)).toBeLessThanOrEqual(30)

    const signed = requests.filter((request) => !request.url.includes('/market/'))
    for (const request of signed) {
      const url = new URL(request.url)
      const timestamp = Number(request.headers.get('X-BAPI-TIMESTAMP'))
      expect(timestamp).toBe(ctx.now.getTime())
      expect(request.headers.get('X-BAPI-API-KEY')).toBe(config.apiKey)
      const recvWindow = Number(request.headers.get('X-BAPI-RECV-WINDOW'))
      expect(request.headers.get('X-BAPI-SIGN')).toBe(
        await signBybit(
          { timestamp, apiKey: config.apiKey, recvWindow, payload: url.search.slice(1) },
          config.apiSecret,
        ),
      )
    }
  })

  test.each([
    [error10003, 'does not know this API key'],
    [error10004, 'API secret does not belong'],
    [error10010, 'IP'],
  ])('validate maps error %# to unauthorized', async (body, message) => {
    // Bybit answers these with HTTP 200 and the code in the envelope.
    const { fetch, requests } = fixtureFetch([{ url: '/v5/account/wallet-balance', json: body }])
    const error = await bybit.validate!(contextFor(bybit, config, fetch)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SourceError)
    expect(error).toMatchObject({ code: 'unauthorized' })
    expect((error as Error).message).toContain(message)
    expect(requests).toHaveLength(1)
  })

  test('maps an error code on a failed HTTP answer too', async () => {
    const { fetch } = fixtureFetch([
      { url: '/v5/account/wallet-balance', status: 401, json: error10003 },
    ])
    await expect(bybit.validate!(contextFor(bybit, config, fetch))).rejects.toMatchObject({
      code: 'unauthorized',
      message: expect.stringContaining('does not know this API key'),
    })
  })

  test('maps rate limits and the regional block', async () => {
    const limited = fixtureFetch([{ url: '/v5/account/wallet-balance', json: error10006 }])
    await expect(bybit.validate!(contextFor(bybit, config, limited.fetch))).rejects.toMatchObject({
      code: 'rate_limited',
    })
    const blocked = fixtureFetch([
      {
        url: '/v5/account/wallet-balance',
        status: 403,
        json: 'The Amazon CloudFront distribution is configured to block access from your country',
      },
    ])
    await expect(bybit.validate!(contextFor(bybit, config, blocked.fetch))).rejects.toMatchObject({
      code: 'upstream',
      message: expect.stringContaining('region'),
    })
  })

  test('never writes the secret to the log, the URL or an error', async () => {
    const { fetch, requests } = fixtureFetch(routes)
    const ctx = contextFor(bybit, config, fetch)
    await bybit.fetchPositions(ctx)
    const failing = fixtureFetch([{ url: '/v5/account/wallet-balance', json: error10004 }])
    const failed = contextFor(bybit, config, failing.fetch)
    const error = await bybit.fetchPositions(failed).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SourceError)
    const seen = [
      ...ctx.log.lines,
      ...failed.log.lines,
      (error as Error).message,
      ...requests.map((request) => `${request.url} ${request.body}`),
      ...requests.flatMap((request) => Array.from(request.headers.values())),
    ]
    for (const line of seen) expect(line).not.toContain(config.apiSecret)
  })
})
