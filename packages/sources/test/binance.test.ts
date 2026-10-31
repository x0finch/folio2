import { describe, expect, test } from 'vitest'

import { binance } from '../src/binance'
import { signBinance } from '../src/binance/sign'
import { SourceError } from '../src/errors'
import { contextFor, fixtureFetch, type FixtureRoute } from '../src/testing'
import account from './fixtures/binance/account.json'
import error1022 from './fixtures/binance/error-1022.json'
import error2014 from './fixtures/binance/error-2014.json'
import error2015 from './fixtures/binance/error-2015.json'
import flexible from './fixtures/binance/flexible.json'
import funding from './fixtures/binance/funding.json'
import locked from './fixtures/binance/locked.json'
import prices from './fixtures/binance/prices.json'
import restricted from './fixtures/binance/restricted-451.json'

const config = {
  apiKey: 'vmPUZE6mv9SD5VNHk4HlWFsOr6aKE2zvsw0MuIgwCIPy6utIco14y7Ju91duEh8A',
  apiSecret: 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j',
}

const routes: FixtureRoute[] = [
  { url: '/api/v3/account?', json: account },
  { url: '/sapi/v1/asset/get-funding-asset?', method: 'POST', json: funding },
  { url: '/sapi/v1/simple-earn/flexible/position?', json: flexible },
  { url: '/sapi/v1/simple-earn/locked/position?', json: locked },
  { url: '/api/v3/ticker/price', json: prices },
]

describe('signing', () => {
  test('matches the HMAC example in Binance request-security docs', async () => {
    const query =
      'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559'
    expect(await signBinance(query, config.apiSecret)).toBe(
      'c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71',
    )
  })
})

describe('binance', () => {
  test('reads spot, funding and Simple Earn balances', async () => {
    const { fetch, requests } = fixtureFetch(routes)
    const ctx = contextFor(binance, config, fetch)
    expect(await binance.fetchPositions(ctx)).toEqual([
      {
        asset: { id: 'coingecko:bitcoin', symbol: 'BTC' },
        amount: '0.6',
        kind: 'spot',
        location: 'spot',
      },
      {
        asset: { id: 'coingecko:lido-dao', symbol: 'LDO' },
        amount: '100',
        kind: 'spot',
        location: 'spot',
      },
      // LDBTC is dropped: the flexible earn endpoint reports the same BTC.
      {
        asset: { id: 'coingecko:usd-coin', symbol: 'USDC' },
        amount: '25',
        kind: 'lending',
        location: 'earn',
      },
      {
        asset: { id: 'cex:ORDI', symbol: 'ORDI' },
        amount: '12.5',
        kind: 'spot',
        location: 'spot',
        priceUsd: 31.2,
      },
      // Free, locked and frozen count; the amount being withdrawn does not.
      {
        asset: { id: 'coingecko:tether', symbol: 'USDT' },
        amount: '1.5',
        kind: 'spot',
        location: 'funding',
      },
      {
        asset: { id: 'coingecko:tether', symbol: 'USDT' },
        amount: '75.46',
        kind: 'lending',
        location: 'earn',
      },
      {
        asset: { id: 'coingecko:bitcoin', symbol: 'BTC' },
        amount: '0.2',
        kind: 'lending',
        location: 'earn',
      },
      {
        asset: { id: 'coingecko:axie-infinity', symbol: 'AXS' },
        amount: '122.09202928',
        kind: 'staked',
        location: 'earn',
      },
    ])
    expect(ctx.fetch.budget.used).toBeLessThanOrEqual(binance.maxRequests(ctx.config))
    expect(binance.maxRequests(ctx.config)).toBeLessThanOrEqual(30)

    const signed = requests.filter((request) => !request.url.includes('/ticker/'))
    expect(signed).toHaveLength(4)
    for (const request of signed) {
      expect(request.headers.get('X-MBX-APIKEY')).toBe(config.apiKey)
      const url = new URL(request.url)
      expect(url.searchParams.get('timestamp')).toBe(String(ctx.now.getTime()))
      // The signature covers everything before it.
      const [unsigned] = url.search.slice(1).split('&signature=')
      expect(url.searchParams.get('signature')).toBe(await signBinance(unsigned!, config.apiSecret))
    }
    // The calls run in parallel, so find the account call rather than assume its position.
    const accountCall = requests.find((request) => request.url.includes('/api/v3/account'))
    expect(accountCall?.url).toContain('omitZeroBalances=true')
  })

  test('skips the price request when every ticker maps to CoinGecko', async () => {
    const { fetch, requests } = fixtureFetch([
      { url: '/api/v3/account?', json: { balances: [{ asset: 'ETH', free: '1', locked: '0' }] } },
      { url: '/get-funding-asset', method: 'POST', json: [] },
      { url: '/flexible/position', json: { rows: [], total: 0 } },
      { url: '/locked/position', json: { rows: [], total: 0 } },
    ])
    const positions = await binance.fetchPositions(contextFor(binance, config, fetch))
    expect(positions).toEqual([
      {
        asset: { id: 'coingecko:ethereum', symbol: 'ETH' },
        amount: '1',
        kind: 'spot',
        location: 'spot',
      },
    ])
    expect(requests).toHaveLength(4)
  })

  test.each([
    [error2015, 'Enable Reading'],
    [error2014, 'format is invalid'],
    [error1022, 'API secret does not belong'],
  ])('validate maps error %# to unauthorized', async (body, message) => {
    const { fetch } = fixtureFetch([{ url: '/api/v3/account?', status: 401, json: body }])
    const ctx = contextFor(binance, config, fetch)
    const error = await binance.validate!(ctx).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SourceError)
    expect(error).toMatchObject({ code: 'unauthorized' })
    expect((error as Error).message).toContain(message)
    expect((error as Error).message).not.toContain(config.apiSecret)
  })

  test('validate makes one request', async () => {
    const { fetch, requests } = fixtureFetch([{ url: '/api/v3/account?', json: account }])
    await binance.validate!(contextFor(binance, config, fetch))
    expect(requests).toHaveLength(1)
  })

  test('maps rate limits, bans and regional blocks', async () => {
    const cases: [number, unknown, string][] = [
      [429, { code: -1003, msg: 'Too many requests.' }, 'rate_limited'],
      [418, { code: -1003, msg: 'Way too many requests; IP banned.' }, 'rate_limited'],
      [451, restricted, 'upstream'],
    ]
    for (const [status, body, code] of cases) {
      const { fetch } = fixtureFetch([{ url: '/api/v3/account?', status, json: body }])
      const error = await binance.validate!(contextFor(binance, config, fetch)).catch(
        (e: unknown) => e,
      )
      expect(error).toMatchObject({ code })
    }
  })

  test('never writes the secret to the log, the URL or an error', async () => {
    const { fetch, requests } = fixtureFetch(routes)
    const ctx = contextFor(binance, config, fetch)
    await binance.fetchPositions(ctx)
    const failing = fixtureFetch([{ url: '/api/v3/account?', status: 401, json: error1022 }])
    const failed = contextFor(binance, config, failing.fetch)
    const error = await binance.fetchPositions(failed).catch((e: unknown) => e)
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

  test('rejects a malformed key before any request', () => {
    expect(binance.config.safeParse({ apiKey: 'short', apiSecret: 'x' }).success).toBe(false)
    expect(binance.config.safeParse({ apiKey: config.apiKey, apiSecret: '' }).success).toBe(false)
    expect(binance.defaultLabel(binance.config.parse(config))).toBe('Binance …Eh8A')
  })
})
