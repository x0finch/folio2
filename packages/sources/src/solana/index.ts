import { base58 } from '@scure/base'
import { Big } from 'big.js'
import { z } from 'zod'

import { coingeckoId, tokenId } from '../asset'
import { defineSource, field } from '../define'
import { fetchJson } from '../fetch'
import { rpcCall } from '../json-rpc'
import { nonZero, type Position } from '../position'
import { fromBaseUnits, toDecimal } from '../units'

const SOLANA_RPC = 'https://api.mainnet-beta.solana.com'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const LAMPORTS_DECIMALS = 9

/** Jupiter's keyless token search: symbol, name, logo and USD price for up to 100 mints. */
const JUPITER_SEARCH = 'https://lite-api.jup.ag/tokens/v2/search'
const LOOKUP_BATCH = 100
/**
 * Jupiter's keyless tier throttles after a handful of calls, so lookups are capped. Mints past
 * the cap (wallets with hundreds of airdropped tokens) are kept unnamed and unpriced.
 */
const MAX_LOOKUPS = 3

/** Tokens worth less than this by Jupiter's price are dropped: mostly airdropped spam. */
const DUST_USD = 1

const isSolanaAddress = (value: string) => {
  try {
    return base58.decode(value).length === 32
  } catch {
    return false
  }
}

const tokenAccounts = z.object({
  value: z.array(
    z.object({
      account: z.object({
        data: z.object({
          parsed: z.object({
            info: z.object({
              mint: z.string(),
              tokenAmount: z.object({
                amount: z.string().regex(/^\d+$/),
                decimals: z.number().int().min(0),
                // Includes Token-2022 UI multipliers (scaled and interest-bearing amounts).
                uiAmountString: z.string(),
              }),
            }),
          }),
        }),
      }),
    }),
  ),
})

const jupiterTokens = z.array(
  z.object({
    id: z.string(),
    symbol: z.string().nullish(),
    name: z.string().nullish(),
    icon: z.string().nullish(),
    usdPrice: z.number().nullish(),
  }),
)
type JupiterToken = z.output<typeof jupiterTokens>[number]

const short = (value: string) => `${value.slice(0, 4)}…${value.slice(-4)}`

/** One Solana address: SOL and SPL tokens of both token programs. */
export const solana = defineSource({
  id: 'solana',
  kind: 'wallet',
  label: 'Solana wallet',
  description: 'A Solana address: SOL and SPL tokens',
  icon: 'https://icons.llamao.fi/icons/chains/rsz_solana.jpg?w=48&h=48',
  config: z.object({
    address: field({ title: 'Address', placeholder: 'Base58 address' }).refine(
      isSolanaAddress,
      'Enter a Solana address (base58, 32 bytes)',
    ),
  }),
  // getBalance + one token-account listing per program + capped Jupiter lookups.
  maxRequests: () => 3 + MAX_LOOKUPS,
  defaultLabel: ({ address }) => short(address),
  fetchPositions: async ({ config, fetch, log }) => {
    const listAccounts = (programId: string) =>
      rpcCall(
        fetch,
        SOLANA_RPC,
        'getTokenAccountsByOwner',
        [config.address, { programId }, { encoding: 'jsonParsed' }],
        tokenAccounts,
      )
    const [balance, legacy, token2022] = await Promise.all([
      rpcCall(fetch, SOLANA_RPC, 'getBalance', [config.address], z.object({ value: z.number() })),
      listAccounts(TOKEN_PROGRAM),
      listAccounts(TOKEN_2022_PROGRAM),
    ])

    // Sum per mint (a wallet can hold several accounts of one mint); skip NFTs (0 decimals).
    const amounts = new Map<string, Big>()
    for (const { account } of [...legacy.value, ...token2022.value]) {
      const { mint, tokenAmount } = account.data.parsed.info
      if (tokenAmount.decimals === 0 || tokenAmount.amount === '0') continue
      amounts.set(mint, (amounts.get(mint) ?? new Big(0)).plus(tokenAmount.uiAmountString))
    }

    const mints = [...amounts.keys()]
    const lookedUp = mints.slice(0, LOOKUP_BATCH * MAX_LOOKUPS)
    const info = new Map<string, JupiterToken>()
    for (let start = 0; start < lookedUp.length; start += LOOKUP_BATCH) {
      const batch = lookedUp.slice(start, start + LOOKUP_BATCH)
      // Jupiter's keyless tier throttles bursts, so the lookups run one after another.
      // oxlint-disable-next-line no-await-in-loop
      const found = await fetchJson(
        fetch,
        `${JUPITER_SEARCH}?query=${batch.join(',')}`,
        jupiterTokens,
      )
      for (const token of found) info.set(token.id, token)
    }
    if (mints.length > lookedUp.length) {
      log.warn('solana: tokens past the lookup cap kept unpriced', {
        count: mints.length - lookedUp.length,
      })
    }

    const positions: Position[] = [
      {
        asset: { id: coingeckoId('solana'), symbol: 'SOL', name: 'Solana' },
        amount: fromBaseUnits(balance.value, LAMPORTS_DECIMALS),
        kind: 'spot',
        location: 'solana',
      },
    ]
    for (const [index, [mint, total]] of [...amounts].entries()) {
      const amount = toDecimal(total.toFixed())
      const token = info.get(mint)
      if (index < lookedUp.length) {
        // Jupiter prices anything with a market; no price means spam or worthless.
        const price = token?.usdPrice ?? 0
        if (!(price > 0) || new Big(amount).times(price).lt(DUST_USD)) continue
      }
      positions.push({
        asset: {
          id: tokenId('solana', mint),
          symbol: token?.symbol || short(mint),
          name: token?.name || undefined,
          logo: token?.icon || undefined,
        },
        amount,
        kind: 'spot',
        location: 'solana',
        priceUsd: token?.usdPrice ?? undefined,
      })
    }
    return nonZero(positions)
  },
})
