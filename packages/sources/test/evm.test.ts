import { describe, expect, test } from 'vitest'

import { SourceError } from '../src/errors'
import { evm } from '../src/evm'
import { EVM_CHAINS } from '../src/evm/chains'
import { contextFor, fixtureFetch, type FixtureRoute } from '../src/testing'
import lifi from './fixtures/evm/lifi-balances.json'
import arbitrum from './fixtures/evm/rpc-arbitrum.json'
import avax from './fixtures/evm/rpc-avax.json'
import base from './fixtures/evm/rpc-base.json'
import bsc from './fixtures/evm/rpc-bsc.json'
import ethereum from './fixtures/evm/rpc-ethereum.json'
import gnosis from './fixtures/evm/rpc-gnosis.json'
import linea from './fixtures/evm/rpc-linea.json'
import optimism from './fixtures/evm/rpc-optimism.json'
import polygon from './fixtures/evm/rpc-polygon.json'
import scroll from './fixtures/evm/rpc-scroll.json'
import zksync from './fixtures/evm/rpc-zksync.json'

const ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'

const rpcAnswers: Record<string, unknown> = {
  ethereum,
  arbitrum,
  base,
  optimism,
  polygon,
  bsc,
  avax,
  gnosis,
  linea,
  scroll,
  zksync,
}

const rpcRoutes = (): FixtureRoute[] =>
  EVM_CHAINS.map((chain) => ({
    url: chain.rpc,
    method: 'POST',
    body: (body) => body.includes('eth_getBalance') && body.includes(ADDRESS.toLowerCase()),
    json: rpcAnswers[chain.key],
  }))

const lifiRoute = (json: unknown = lifi, status = 200): FixtureRoute => ({
  url: `li.quest/v1/wallets/${ADDRESS.toLowerCase()}/balances`,
  json,
  status,
})

async function run(routes: FixtureRoute[]) {
  const { fetch, requests } = fixtureFetch(routes)
  const ctx = contextFor(evm, { address: ADDRESS }, fetch)
  const positions = await evm.fetchPositions(ctx)
  return { positions, requests, ctx }
}

describe('evm', () => {
  test('reads native balances per chain and priced tokens from LI.FI', async () => {
    const { positions, requests, ctx } = await run([...rpcRoutes(), lifiRoute()])

    const natives = positions.filter((position) => position.asset.id.startsWith('coingecko:'))
    expect(
      natives.map((position) => [position.location, position.asset.id, position.amount]),
    ).toEqual([
      ['ethereum', 'coingecko:ethereum', '5.779567498611001236'],
      ['arbitrum', 'coingecko:ethereum', '0.159411760907900921'],
      ['base', 'coingecko:ethereum', '3.12882281347273728'],
      ['optimism', 'coingecko:ethereum', '0.181079591875347535'],
      ['polygon', 'coingecko:polygon-ecosystem-token', '592.719867156692654977'],
      ['bsc', 'coingecko:binancecoin', '0.17008130133610404'],
      ['avax', 'coingecko:avalanche-2', '0.324952024142594956'],
      ['gnosis', 'coingecko:xdai', '8.709546191240796693'],
      ['linea', 'coingecko:ethereum', '0.006803680919043338'],
      ['scroll', 'coingecko:ethereum', '0.070942521591221114'],
      ['zksync', 'coingecko:ethereum', '0.012233552060381682'],
    ])

    expect(positions).toContainEqual({
      asset: {
        id: 'arbitrum:0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f',
        symbol: 'WBTC',
        name: 'WBTC',
        logo: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599/logo.png',
      },
      amount: '0.00109695',
      kind: 'spot',
      location: 'arbitrum',
      priceUsd: 77223.4517573845,
    })

    const ids = positions.map((position) => position.asset.id)
    // Priced below a dollar: airdropped XEN, BOND dust.
    expect(ids).not.toContain('ethereum:0x06450dee7fd2fb8e39061434babcfc05599a6fb8')
    expect(ids).not.toContain('ethereum:0x0391d2021f89dc339f60fff84546ea23e337750f')
    // LI.FI's native rows don't duplicate the RPC balances.
    expect(ids).not.toContain('ethereum:0x0000000000000000000000000000000000000000')
    // Chains outside the list (Celo, Unichain...) are dropped.
    expect(positions.every((position) => EVM_CHAINS.some((c) => c.key === position.location))).toBe(
      true,
    )
    const keys = positions.map((position) => `${position.location} ${position.asset.id}`)
    expect(new Set(keys).size).toBe(keys.length)
    expect(positions).toMatchSnapshot()

    expect(requests).toHaveLength(EVM_CHAINS.length + 1)
    expect(ctx.fetch.budget.used).toBeLessThanOrEqual(evm.maxRequests(ctx.config))
    expect(evm.maxRequests(ctx.config)).toBeLessThanOrEqual(30)
  })

  test('drops tokens LI.FI has no price for', async () => {
    const token = {
      address: '0x1111111111111111111111111111111111111111',
      symbol: 'SPAM',
      decimals: 18,
      amount: '1000000000000000000000000',
      chainId: 1,
    }
    const { positions } = await run([
      ...rpcRoutes(),
      lifiRoute({ walletAddress: ADDRESS, balances: { '1': [token, { odd: true }] } }),
    ])
    expect(positions.map((position) => position.asset.id)).not.toContain(
      'ethereum:0x1111111111111111111111111111111111111111',
    )
  })

  test('validates the address before any request', () => {
    expect(evm.config.safeParse({ address: ADDRESS }).success).toBe(true)
    expect(evm.config.safeParse({ address: ADDRESS.toLowerCase() }).success).toBe(true)
    expect(evm.config.safeParse({ address: ADDRESS.slice(0, -1) }).success).toBe(false)
    expect(evm.config.safeParse({ address: 'vitalik.eth' }).success).toBe(false)
    expect(evm.config.safeParse({ address: `${ADDRESS.slice(0, -1)}g` }).success).toBe(false)
  })

  test.each([
    [429, 'rate_limited'],
    [403, 'unauthorized'],
    [500, 'upstream'],
  ])('maps LI.FI %i to %s', async (status, code) => {
    const failure = run([...rpcRoutes(), lifiRoute({ message: 'nope' }, status)])
    await expect(failure).rejects.toBeInstanceOf(SourceError)
    await expect(failure).rejects.toMatchObject({ code })
  })

  test('maps a JSON-RPC error body', async () => {
    const routes = rpcRoutes()
    routes[0] = {
      url: EVM_CHAINS[0]?.rpc ?? '',
      method: 'POST',
      json: { jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'rate limit' } },
    }
    await expect(run([...routes, lifiRoute()])).rejects.toMatchObject({ code: 'rate_limited' })
    routes[0] = {
      ...routes[0],
      json: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'x' } },
    }
    await expect(run([...routes, lifiRoute()])).rejects.toMatchObject({ code: 'upstream' })
  })

  test('labels a connection with the short address', () => {
    expect(evm.defaultLabel({ address: ADDRESS })).toBe('0xd8dA…6045')
  })
})
