import { base58 } from '@scure/base'
import { describe, expect, test } from 'vitest'

import { solana } from '../src/solana'
import { contextFor, fixtureFetch, type FixtureRoute } from '../src/testing'
import balance from './fixtures/solana/balance.json'
import jupiter from './fixtures/solana/jupiter-search.json'
import token2022Accounts from './fixtures/solana/token-2022-accounts.json'
import tokenAccounts from './fixtures/solana/token-accounts.json'

const ADDRESS = '86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY'
const RPC = 'https://api.mainnet-beta.solana.com'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'

const rpcRoute = (method: string, json: unknown, program?: string): FixtureRoute => ({
  url: RPC,
  method: 'POST',
  body: (body) => body.includes(`"${method}"`) && (!program || body.includes(program)),
  json,
})

const routes = (
  overrides: { tokens?: unknown; tokens2022?: unknown; jupiter?: FixtureRoute } = {},
): FixtureRoute[] => [
  rpcRoute('getBalance', balance),
  rpcRoute('getTokenAccountsByOwner', overrides.tokens ?? tokenAccounts, TOKEN_PROGRAM),
  rpcRoute(
    'getTokenAccountsByOwner',
    overrides.tokens2022 ?? token2022Accounts,
    TOKEN_2022_PROGRAM,
  ),
  overrides.jupiter ?? { url: 'lite-api.jup.ag/tokens/v2/search', json: jupiter },
]

async function run(list: FixtureRoute[]) {
  const { fetch, requests } = fixtureFetch(list)
  const ctx = contextFor(solana, { address: ADDRESS }, fetch)
  const positions = await solana.fetchPositions(ctx)
  return { positions, requests, ctx }
}

describe('solana', () => {
  test('reads SOL and priced SPL tokens of both token programs', async () => {
    const { positions, requests, ctx } = await run(routes())
    expect(positions).toEqual([
      {
        asset: { id: 'coingecko:solana', symbol: 'SOL', name: 'Solana' },
        amount: '1329.753092689',
        kind: 'spot',
        location: 'solana',
      },
      {
        asset: {
          id: 'solana:DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
          symbol: 'Bonk',
          name: 'Bonk',
          logo: 'https://arweave.net/hQiPZOsRZXGXBJd_82PhVdlM_hACsT_q6wqwf5cSY7I',
        },
        amount: '397586970.55337',
        kind: 'spot',
        location: 'solana',
        priceUsd: 2.92702947369104e-6,
      },
      {
        asset: {
          id: 'solana:AT79ReYU9XtHUTF5vM6Q4oa9K8w7918Fp5SU7G1MDMQY',
          symbol: 'SPDR',
          name: 'SpiderSwap',
          logo: 'https://arweave.net/PAVQPYRQzq2g4O2X7hDzOniW4aBE9PJ19U56MRVpIfA',
        },
        amount: '500000000',
        kind: 'spot',
        location: 'solana',
        priceUsd: 0.0022325198850840803,
      },
      {
        asset: {
          id: 'solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          symbol: 'USDC',
          name: 'USD Coin',
          logo: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png',
        },
        amount: '561.397867',
        kind: 'spot',
        location: 'solana',
        priceUsd: 0.9998920208118847,
      },
      {
        // Token-2022 with a UI multiplier: the amount is the scaled one, not raw / 10^decimals.
        asset: {
          id: 'solana:XsqE9cRRpzxcGKDXj1BJ7Xmg4GRhZoyY1KpmGSxAWT2',
          symbol: 'MCDx',
          name: "McDonald's xStock",
          logo: 'https://xstocks-metadata.backed.fi/logos/tokens/MCDx.png',
        },
        amount: '0.19871043',
        kind: 'spot',
        location: 'solana',
        priceUsd: 260.27558406480483,
      },
      {
        asset: {
          id: 'solana:SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb',
          symbol: 'SPCX',
          name: 'SpaceX - Backpack Securities',
          logo: 'https://s3-symbol-logo.tradingview.com/spacex.svg',
        },
        amount: '43.571153',
        kind: 'spot',
        location: 'solana',
        priceUsd: 137.1718578237782,
      },
    ])
    // Dropped: JUP dust, unpriced Doink and Comrades, zero balances, NFTs (0 decimals).
    expect(requests).toHaveLength(4)
    expect(requests[3]?.url).toContain('query=AKxNZzXx3BdzSL6xXnAmUnVPsR8yBW1d2MBbJjRpzg74,')
    expect(ctx.fetch.budget.used).toBeLessThanOrEqual(solana.maxRequests(ctx.config))
    expect(solana.maxRequests(ctx.config)).toBeLessThanOrEqual(30)
  })

  test('caps Jupiter lookups and keeps the rest unpriced with a short symbol', async () => {
    const mints = Array.from({ length: 350 }, (_, index) =>
      base58.encode(
        Uint8Array.from(
          { length: 32 },
          (_unused, byte) => (byte === 0 ? index % 256 : index >> 8) + 1,
        ),
      ),
    )
    const tokens = {
      jsonrpc: '2.0',
      id: 1,
      result: {
        context: { slot: 1 },
        value: mints.map((mint) => ({
          account: {
            data: {
              parsed: {
                info: {
                  mint,
                  tokenAmount: { amount: '5', decimals: 1, uiAmount: 0.5, uiAmountString: '0.5' },
                },
              },
            },
          },
        })),
      },
    }
    const { positions, requests, ctx } = await run(
      routes({
        tokens,
        tokens2022: { jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: [] } },
        jupiter: { url: 'lite-api.jup.ag/tokens/v2/search', json: [] },
      }),
    )
    expect(requests.filter((request) => request.url.includes('jup.ag'))).toHaveLength(3)
    expect(ctx.fetch.budget.used).toBe(solana.maxRequests(ctx.config))
    // 300 looked up and unpriced → dropped; 50 past the cap kept.
    const last = mints[349] ?? ''
    expect(positions).toHaveLength(51)
    expect(positions.at(-1)).toEqual({
      asset: { id: `solana:${last}`, symbol: `${last.slice(0, 4)}…${last.slice(-4)}` },
      amount: '0.5',
      kind: 'spot',
      location: 'solana',
    })
    expect(ctx.log.lines).toEqual(['solana: tokens past the lookup cap kept unpriced {"count":50}'])
  })

  test('validates the address before any request', () => {
    expect(solana.config.safeParse({ address: ADDRESS }).success).toBe(true)
    expect(solana.config.safeParse({ address: ADDRESS.slice(0, -2) }).success).toBe(false)
    // 0, O, I and l are not base58.
    expect(solana.config.safeParse({ address: `0${ADDRESS.slice(1)}` }).success).toBe(false)
    expect(
      solana.config.safeParse({ address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' }).success,
    ).toBe(false)
  })

  test('maps throttling to rate_limited', async () => {
    const throttled = {
      jsonrpc: '2.0',
      error: { code: 429, message: 'Too many requests for a specific RPC call' },
      id: 1,
    }
    const list = routes()
    list[0] = rpcRoute('getBalance', throttled)
    await expect(run(list)).rejects.toMatchObject({ code: 'rate_limited' })

    const jupiterDown = routes({
      jupiter: { url: 'lite-api.jup.ag/tokens/v2/search', status: 429, json: {} },
    })
    await expect(run(jupiterDown)).rejects.toMatchObject({ code: 'rate_limited' })
  })

  test('maps an unexpected answer to upstream', async () => {
    const list = routes()
    list[0] = rpcRoute('getBalance', { jsonrpc: '2.0', id: 1, result: { nope: true } })
    await expect(run(list)).rejects.toMatchObject({ code: 'upstream' })
  })

  test('labels a connection with the short address', () => {
    expect(solana.defaultLabel({ address: ADDRESS })).toBe('86xC…2MMY')
  })
})
