import { Big } from 'big.js'
import { z } from 'zod'

import { coingeckoId, tokenId } from '../asset'
import { defineSource, field } from '../define'
import { fetchJson, type FetchLike } from '../fetch'
import { rpcCall } from '../json-rpc'
import { nonZero, type Position } from '../position'
import { fromBaseUnits } from '../units'
import { EVM_CHAINS, type EvmChain } from './chains'

const LIFI_BALANCES = 'https://li.quest/v1/wallets'

/**
 * Tokens worth less than this (by LI.FI's own price) are dropped. Airdropped spam is priced
 * near zero, so a value cut removes most of it while losing almost nothing real.
 */
const DUST_USD = 1

/** How LI.FI (and most EVM tooling) names the native coin instead of a contract. */
const NATIVE_ADDRESSES: ReadonlySet<string> = new Set([
  '0x0000000000000000000000000000000000000000',
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
])

const lifiToken = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  symbol: z.string(),
  name: z.string().optional(),
  decimals: z.number().int().min(0).max(36),
  amount: z.string().regex(/^\d+$/),
  priceUSD: z.string().optional(),
  logoURI: z.string().optional(),
})

const lifiBalances = z.object({
  // Items are checked one by one below, so one odd token can't fail the whole wallet.
  balances: z.record(z.string(), z.array(z.unknown())),
})

const hexQuantity = z.string().regex(/^0x[0-9a-fA-F]+$/)

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`

/** Native coin balance on one chain, read from its public RPC. */
async function nativePosition(
  fetch: FetchLike,
  chain: EvmChain,
  address: string,
): Promise<Position> {
  const wei = await rpcCall(fetch, chain.rpc, 'eth_getBalance', [address, 'latest'], hexQuantity)
  return {
    asset: {
      id: coingeckoId(chain.native.coingeckoId),
      symbol: chain.native.symbol,
      name: chain.native.name,
    },
    amount: fromBaseUnits(BigInt(wei), 18),
    kind: 'spot',
    location: chain.key,
  }
}

/** One wallet address on the major EVM chains: native coins and ERC-20 tokens. */
export const evm = defineSource({
  id: 'evm',
  kind: 'wallet',
  label: 'EVM wallet',
  description: 'An address on Ethereum, Arbitrum, Base, Optimism, Polygon, BNB Chain and more',
  icon: 'https://icons.llamao.fi/icons/chains/rsz_ethereum.jpg?w=48&h=48',
  config: z.object({
    address: field({ title: 'Address', placeholder: '0x…' }).regex(
      /^0x[0-9a-fA-F]{40}$/,
      'Enter an address like 0x followed by 40 hex characters',
    ),
  }),
  // One balance call per chain plus one LI.FI call for all tokens.
  maxRequests: () => EVM_CHAINS.length + 1,
  defaultLabel: ({ address }) => short(address),
  fetchPositions: async ({ config, fetch, log }) => {
    const address = config.address.toLowerCase()
    const [natives, tokens] = await Promise.all([
      Promise.all(EVM_CHAINS.map((chain) => nativePosition(fetch, chain, address))),
      fetchJson(fetch, `${LIFI_BALANCES}/${address}/balances?extended=true`, lifiBalances),
    ])

    const positions: Position[] = [...natives]
    const seen = new Set<string>()
    let malformed = 0
    for (const chain of EVM_CHAINS) {
      for (const item of tokens.balances[String(chain.chainId)] ?? []) {
        const parsed = lifiToken.safeParse(item)
        if (!parsed.success) {
          malformed += 1
          continue
        }
        const token = parsed.data
        const id = tokenId(chain.key, token.address)
        // Natives come from the chain's RPC; LI.FI sometimes lists a token twice.
        if (NATIVE_ADDRESSES.has(token.address.toLowerCase()) || seen.has(id)) continue
        seen.add(id)
        const amount = fromBaseUnits(token.amount, token.decimals)
        const price = Number(token.priceUSD)
        // No price means LI.FI doesn't know a market for it: spam, or worthless.
        if (!(price > 0) || new Big(amount).times(price).lt(DUST_USD)) continue
        positions.push({
          asset: { id, symbol: token.symbol, name: token.name, logo: token.logoURI },
          amount,
          kind: 'spot',
          location: chain.key,
          priceUsd: price,
        })
      }
    }
    if (malformed > 0) log.warn('evm: skipped malformed tokens', { count: malformed })
    return nonZero(positions)
  },
})
