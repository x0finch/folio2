import { describe, expect, test } from 'vitest'

import { SourceError } from '../src/errors'
import { okx } from '../src/okx'
import { signOkx } from '../src/okx/sign'
import { contextFor, fixtureFetch, type FixtureRoute } from '../src/testing'
import accountBalance from './fixtures/okx/account-balance.json'
import assetBalances from './fixtures/okx/asset-balances.json'
import error50103 from './fixtures/okx/error-50103.json'
import error50105 from './fixtures/okx/error-50105.json'
import error50113 from './fixtures/okx/error-50113.json'
import error50119 from './fixtures/okx/error-50119.json'
import tickers from './fixtures/okx/market-tickers.json'

const config = {
  apiKey: '37c541a1-0000-4000-8000-10fe7a038418',
  apiSecret: '22582BD0CFF14C41EDBF1AB98506286D',
  passphrase: 'correct horse battery staple',
}

const routes: FixtureRoute[] = [
  { url: '/api/v5/account/balance', json: accountBalance },
  { url: '/api/v5/asset/balances', json: assetBalances },
  { url: '/api/v5/market/tickers?instType=SPOT', json: tickers },
]

describe('signing', () => {
  test('signs timestamp + method + requestPath + body as base64 HMAC-SHA256', async () => {
    // The pre-hash string of the example in OKX's "Signing Messages" docs. OKX publishes no
    // secret for it, so the expected value was computed independently with Node's
    // `createHmac('sha256', secret).update(prehash).digest('base64')`.
    const signature = await signOkx(
      {
        timestamp: '2020-12-08T09:08:57.715Z',
        method: 'GET',
        requestPath: '/api/v5/account/balance?ccy=BTC',
      },
      config.apiSecret,
    )
    expect(signature).toBe('HiZhvSfMtWJA3uUIVXV3a/bSXNPCWvYFXoGCVS8V4zY=')
  })
})

describe('okx', () => {
  test('reads trading and funding balances', async () => {
    const { fetch, requests } = fixtureFetch(routes)
    const ctx = contextFor(okx, config, fetch)
    expect(await okx.fetchPositions(ctx)).toEqual([
      {
        asset: { id: 'coingecko:tether', symbol: 'USDT' },
        amount: '4992.890093622894',
        kind: 'spot',
        location: 'trading',
        priceUsd: expect.closeTo(0.99973, 5),
      },
      {
        asset: { id: 'coingecko:bitcoin', symbol: 'BTC' },
        amount: '0.25',
        kind: 'spot',
        location: 'trading',
        priceUsd: 77377.92,
      },
      {
        asset: { id: 'cex:PEOPLE', symbol: 'PEOPLE' },
        amount: '1000',
        kind: 'spot',
        location: 'trading',
        priceUsd: 0.00623,
      },
      {
        asset: { id: 'coingecko:ethereum', symbol: 'ETH' },
        amount: '0.5',
        kind: 'borrowed',
        location: 'trading',
        priceUsd: 2243.98,
      },
      // The zero SOL row is dropped.
      {
        asset: { id: 'coingecko:ethereum', symbol: 'ETH' },
        amount: '37.11827078',
        kind: 'spot',
        location: 'funding',
        priceUsd: 2243.98,
      },
      // Not in the trading account, so priced from the spot tickers.
      {
        asset: { id: 'cex:ORDI', symbol: 'ORDI' },
        amount: '50',
        kind: 'spot',
        location: 'funding',
        priceUsd: 3.468,
      },
    ])
    expect(ctx.fetch.budget.used).toBe(3)
    expect(ctx.fetch.budget.used).toBeLessThanOrEqual(okx.maxRequests(ctx.config))
    expect(okx.maxRequests(ctx.config)).toBeLessThanOrEqual(30)

    const signed = requests.filter((request) => !request.url.includes('/market/'))
    for (const request of signed) {
      const url = new URL(request.url)
      expect(request.headers.get('OK-ACCESS-KEY')).toBe(config.apiKey)
      expect(request.headers.get('OK-ACCESS-PASSPHRASE')).toBe(config.passphrase)
      expect(request.headers.get('OK-ACCESS-TIMESTAMP')).toBe('2026-10-01T00:00:00.000Z')
      expect(request.headers.get('OK-ACCESS-SIGN')).toBe(
        await signOkx(
          { timestamp: '2026-10-01T00:00:00.000Z', method: 'GET', requestPath: url.pathname },
          config.apiSecret,
        ),
      )
    }
    const ticker = requests.find((request) => request.url.includes('/market/'))
    expect(ticker?.headers.has('OK-ACCESS-KEY')).toBe(false)
  })

  test.each([
    [401, error50119, 'does not know this API key'],
    [401, error50113, 'API secret does not belong'],
    [401, error50105, 'passphrase'],
    // OKX documents some auth errors with HTTP 200 and the code in the body.
    [200, { code: '50120', msg: 'No permission', data: [] }, 'Read'],
  ])('validate maps an HTTP %d answer to unauthorized (%#)', async (status, body, message) => {
    const { fetch, requests } = fixtureFetch([
      { url: '/api/v5/account/balance', status, json: body },
    ])
    const ctx = contextFor(okx, config, fetch)
    const error = await okx.validate!(ctx).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SourceError)
    expect(error).toMatchObject({ code: 'unauthorized' })
    expect((error as Error).message).toContain(message)
    expect(requests).toHaveLength(1)
  })

  test('maps rate limits and unknown codes', async () => {
    const limited = fixtureFetch([
      {
        url: '/api/v5/account/balance',
        status: 429,
        json: { code: '50011', msg: 'Too Many Requests' },
      },
    ])
    await expect(okx.validate!(contextFor(okx, config, limited.fetch))).rejects.toMatchObject({
      code: 'rate_limited',
    })
    const unknown = fixtureFetch([
      { url: '/api/v5/account/balance', status: 401, json: error50103 },
    ])
    await expect(okx.validate!(contextFor(okx, config, unknown.fetch))).rejects.toMatchObject({
      code: 'unauthorized',
    })
    const odd = fixtureFetch([
      { url: '/api/v5/account/balance', json: { code: '59999', msg: 'Something', data: [] } },
    ])
    await expect(okx.validate!(contextFor(okx, config, odd.fetch))).rejects.toMatchObject({
      code: 'upstream',
      message: 'OKX answered error code 59999',
    })
  })

  test('never writes the secret or passphrase to the log or an error', async () => {
    const { fetch, requests } = fixtureFetch(routes)
    const ctx = contextFor(okx, config, fetch)
    await okx.fetchPositions(ctx)
    const failing = fixtureFetch([
      { url: '/api/v5/account/balance', status: 401, json: error50113 },
    ])
    const failed = contextFor(okx, config, failing.fetch)
    const error = await okx.fetchPositions(failed).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SourceError)
    const seen = [
      ...ctx.log.lines,
      ...failed.log.lines,
      (error as Error).message,
      ...requests.map((request) => `${request.url} ${request.body}`),
    ]
    for (const line of seen) {
      expect(line).not.toContain(config.apiSecret)
      expect(line).not.toContain(config.passphrase)
    }
  })

  test('requires the passphrase', () => {
    expect(okx.config.safeParse({ ...config, passphrase: '' }).success).toBe(false)
    expect(okx.defaultLabel(okx.config.parse(config))).toBe('OKX …8418')
  })
})
