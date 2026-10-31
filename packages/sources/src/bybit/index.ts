import { Big } from 'big.js'
import { z } from 'zod'

import { defineSource, type SourceContext } from '../define'
import { SourceError } from '../errors'
import {
  apiKeyField,
  apiSecretField,
  keyLabel,
  optionalVenueDecimal,
  unitPrice,
  venueDecimal,
} from '../exchanges/config'
import { throwForCode, withErrorCodes, type ErrorCodeMapper } from '../exchanges/errors'
import { fetchJson } from '../fetch'
import { nonZero, type Position } from '../position'
import { tickerAsset } from '../tickers'
import { bybitHeaders } from './sign'

const BASE = 'https://api.bybit.com'
/** The quote coin venue prices are read against; USDT is treated as one US dollar. */
const QUOTE = 'USDT'

/** Every Bybit v5 answer: `retCode` 0 on success, an error code otherwise, with `result`. */
const envelope = z.object({ retCode: z.number(), result: z.unknown() })

const walletSchema = z.object({
  list: z.array(
    z.object({
      coin: z.array(
        z.object({ coin: z.string(), equity: venueDecimal, usdValue: optionalVenueDecimal }),
      ),
    }),
  ),
})
const fundSchema = z.object({
  balance: z.array(z.object({ coin: z.string(), walletBalance: venueDecimal })),
})
const tickersSchema = z.object({
  list: z.array(z.object({ symbol: z.string(), lastPrice: optionalVenueDecimal })),
})

const config = z.object({ apiKey: apiKeyField(), apiSecret: apiSecretField() })
type Config = z.output<typeof config>

/** Bybit error codes worth a clear message (https://bybit-exchange.github.io/docs/v5/error). */
const mapError: ErrorCodeMapper = (code, status) => {
  // Bybit's CDN answers 403 without a code to blocked regions and to IPs it banned for too
  // many requests: neither is about the key.
  if (status === 403 && code === undefined) {
    return new SourceError(
      'upstream',
      'Bybit refused this server: its region is blocked or its IP is temporarily banned',
    )
  }
  switch (code) {
    case '10003':
      return new SourceError(
        'unauthorized',
        'Bybit does not know this API key (keys from testnet or another Bybit region do not work)',
      )
    case '10004':
      return new SourceError(
        'unauthorized',
        'Bybit rejected the signature: the API secret does not belong to this API key',
      )
    case '10010':
      return new SourceError(
        'unauthorized',
        "Bybit refused this server's IP: the key is limited to other IP addresses",
      )
    case '10005':
      return new SourceError(
        'unauthorized',
        'The Bybit API key lacks the permission to read balances',
      )
    case '33004':
      return new SourceError('unauthorized', 'The Bybit API key has expired')
    case '10002':
      return new SourceError('upstream', 'Bybit rejected the request time; it will be retried')
    case '10006':
    case '10018':
      return new SourceError('rate_limited', 'Bybit rate limited the sync')
    default:
      return undefined
  }
}

/** Fetches a Bybit endpoint (signed when `signed`) and returns its `result` after `retCode`. */
async function call<T extends z.ZodType>(
  ctx: SourceContext<Config>,
  path: string,
  query: string,
  schema: T,
  signed = true,
): Promise<z.output<T>> {
  const headers = signed ? await bybitHeaders(query, ctx.now.getTime(), ctx.config) : undefined
  const fetch = withErrorCodes(ctx.fetch, mapError)
  const body = await fetchJson(fetch, `${BASE}${path}?${query}`, envelope, { headers })
  if (body.retCode !== 0) throwForCode(String(body.retCode), mapError, 'Bybit')
  const result = schema.safeParse(body.result)
  if (!result.success) {
    throw new SourceError('upstream', 'Bybit answered an unexpected shape', { cause: result.error })
  }
  return result.data
}

const readWallet = (ctx: SourceContext<Config>) =>
  call(ctx, '/v5/account/wallet-balance', 'accountType=UNIFIED', walletSchema)

/** USD prices for `cex:` assets the account didn't price, from Bybit's USDT spot pairs. */
async function venuePrices(ctx: SourceContext<Config>, positions: Position[]) {
  const missing = positions.some((p) => p.asset.id.startsWith('cex:') && p.priceUsd === undefined)
  if (!missing) return positions
  const tickers = await call(ctx, '/v5/market/tickers', 'category=spot', tickersSchema, false)
  const bySymbol = new Map(tickers.list.map((row) => [row.symbol, row.lastPrice]))
  return positions.map((p) => {
    if (!p.asset.id.startsWith('cex:') || p.priceUsd !== undefined) return p
    const last = bySymbol.get(`${p.asset.symbol}${QUOTE}`)
    return last ? { ...p, priceUsd: Number(last) } : p
  })
}

/**
 * Bybit Unified Trading Account and Funding account balances, read with a read-only API key.
 * Coin equity includes the unrealized PnL of derivatives margined in that coin; the derivative
 * positions themselves are not listed yet. Classic (non-unified) accounts are not supported.
 */
export const bybit = defineSource({
  id: 'bybit',
  kind: 'exchange',
  label: 'Bybit',
  description: 'Unified trading and funding account balances through a read-only API key',
  icon: 'https://icons.llamao.fi/icons/protocols/bybit?w=48&h=48',
  config: config.meta({
    description:
      'Create a system-generated API key with "Read-Only" permissions (Account → API). Never enable trading or withdrawals for Folio.',
  }),
  // Unified wallet, funding wallet, and one spot ticker list for unknown coins.
  maxRequests: () => 3,
  defaultLabel: ({ apiKey }) => keyLabel('Bybit', apiKey),
  validate: async (ctx) => {
    await readWallet(ctx)
  },
  fetchPositions: async (ctx) => {
    const [wallet, fund] = await Promise.all([
      readWallet(ctx),
      call(ctx, '/v5/asset/transfer/query-account-coins-balance', 'accountType=FUND', fundSchema),
    ])
    const coins = wallet.list.flatMap((account) => account.coin)
    const prices = new Map(coins.map((row) => [row.coin, unitPrice(row.usdValue, row.equity)]))
    const positions = nonZero([
      ...coins.map((row): Position => {
        const equity = new Big(row.equity)
        return {
          asset: tickerAsset(row.coin),
          amount: equity.abs().toFixed(),
          // Negative equity is a spot margin loan.
          kind: equity.lt(0) ? 'borrowed' : 'spot',
          location: 'unified',
          priceUsd: prices.get(row.coin),
        }
      }),
      ...fund.balance.map((row): Position => ({
        asset: tickerAsset(row.coin),
        amount: row.walletBalance,
        kind: 'spot',
        location: 'funding',
        priceUsd: prices.get(row.coin),
      })),
    ])
    ctx.log.info('Bybit balances read', { positions: positions.length })
    return venuePrices(ctx, positions)
  },
})
