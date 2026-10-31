import { z } from 'zod'

import { defineSource, type SourceContext } from '../define'
import { SourceError } from '../errors'
import {
  apiKeyField,
  apiSecretField,
  keyLabel,
  sumDecimals,
  venueDecimal,
} from '../exchanges/config'
import { withErrorCodes, type ErrorCodeMapper } from '../exchanges/errors'
import { fetchJson, type FetchLike } from '../fetch'
import { nonZero, type Position, type PositionKind } from '../position'
import { isKnownTicker, tickerAsset } from '../tickers'
import { signedQuery } from './sign'

const BASE = 'https://api.binance.com'
/** Simple Earn pages hold at most 100 rows; one page per product type is read. */
const EARN_PAGE_SIZE = 100
/** The quote asset venue prices are read against; USDT is treated as one US dollar. */
const QUOTE = 'USDT'
/** Binance prefixes Simple Earn flexible receipts in the spot wallet with this (LDBTC). */
const EARN_RECEIPT_PREFIX = 'LD'

const decimal = venueDecimal

const accountSchema = z.object({
  balances: z.array(z.object({ asset: z.string(), free: decimal, locked: decimal })),
})
const fundingSchema = z.array(
  z.object({ asset: z.string(), free: decimal, locked: decimal, freeze: decimal }),
)
const flexibleSchema = z.object({
  rows: z.array(z.object({ asset: z.string(), totalAmount: decimal })),
  total: z.number(),
})
const lockedSchema = z.object({
  rows: z.array(z.object({ asset: z.string(), amount: decimal })),
  total: z.number(),
})
const pricesSchema = z.array(z.object({ symbol: z.string(), price: decimal }))

const config = z.object({ apiKey: apiKeyField(), apiSecret: apiSecretField() })
type Config = z.output<typeof config>

/** Binance error codes worth a clear message (https://developers.binance.com/docs). */
const mapError: ErrorCodeMapper = (code, status) => {
  switch (code) {
    case '-2015':
      return new SourceError(
        'unauthorized',
        'Binance rejected the API key: check that it exists, has "Enable Reading" permission and allows this server\'s IP',
      )
    case '-2014':
      return new SourceError('unauthorized', 'Binance says the API key format is invalid')
    case '-1022':
      return new SourceError(
        'unauthorized',
        'Binance rejected the signature: the API secret does not belong to this API key',
      )
    case '-1021':
      return new SourceError('upstream', 'Binance rejected the request time; it will be retried')
    case '-1003':
      return new SourceError('rate_limited', 'Binance rate limited the sync')
  }
  if (status === 418) return new SourceError('rate_limited', 'Binance temporarily banned this IP')
  if (status === 451) {
    return new SourceError(
      'upstream',
      'Binance refuses requests from the region this server runs in',
    )
  }
  return undefined
}

function signedGet<T extends z.ZodType>(
  ctx: SourceContext<Config>,
  path: string,
  params: Record<string, string>,
  schema: T,
  method = 'GET',
) {
  const fetch: FetchLike = withErrorCodes(ctx.fetch, mapError)
  return signedQuery(params, ctx.config.apiSecret, ctx.now.getTime()).then((query) =>
    fetchJson(fetch, `${BASE}${path}?${query}`, schema, {
      method,
      headers: { 'X-MBX-APIKEY': ctx.config.apiKey },
    }),
  )
}

const position = (
  symbol: string,
  amount: string,
  kind: PositionKind,
  location: string,
): Position => ({ asset: tickerAsset(symbol), amount, kind, location })

/** The coin behind an earn receipt (LDBTC → BTC); real tickers that start with LD stay. */
function earnReceiptBase(symbol: string): string | undefined {
  if (isKnownTicker(symbol) || !symbol.startsWith(EARN_RECEIPT_PREFIX)) return undefined
  const base = symbol.slice(EARN_RECEIPT_PREFIX.length)
  return base === '' ? undefined : base
}

/** USD prices for `cex:` assets, from the venue's USDT pairs. One request for every symbol. */
async function venuePrices(ctx: SourceContext<Config>, positions: Position[]) {
  const unknown = new Set(
    positions.filter((p) => p.asset.id.startsWith('cex:')).map((p) => p.asset.symbol),
  )
  if (unknown.size === 0) return positions
  // All symbols in one call: asking for a list fails as a whole if one symbol has no pair.
  const prices = await fetchJson(
    withErrorCodes(ctx.fetch, mapError),
    `${BASE}/api/v3/ticker/price`,
    pricesSchema,
  )
  const bySymbol = new Map(prices.map((row) => [row.symbol, Number(row.price)]))
  return positions.map((p) => {
    const price = unknown.has(p.asset.symbol)
      ? bySymbol.get(`${p.asset.symbol}${QUOTE}`)
      : undefined
    return price ? { ...p, priceUsd: price } : p
  })
}

/**
 * Binance spot, funding and Simple Earn balances, read with a read-only API key. Futures and
 * margin accounts are not read yet.
 */
export const binance = defineSource({
  id: 'binance',
  kind: 'exchange',
  label: 'Binance',
  description: 'Spot, funding and Simple Earn balances through a read-only API key',
  icon: 'https://icons.llamao.fi/icons/protocols/binance-cex?w=48&h=48',
  config: config.meta({
    description:
      'Create an API key with only "Enable Reading" ticked (API Management in your Binance account). Never enable trading or withdrawals for Folio.',
  }),
  // Account, funding, flexible earn, locked earn, and one price list for unknown tickers.
  maxRequests: () => 5,
  defaultLabel: ({ apiKey }) => keyLabel('Binance', apiKey),
  validate: async (ctx) => {
    await signedGet(ctx, '/api/v3/account', { omitZeroBalances: 'true' }, accountSchema)
  },
  fetchPositions: async (ctx) => {
    const page = { current: '1', size: String(EARN_PAGE_SIZE) }
    const [account, funding, flexible, locked] = await Promise.all([
      signedGet(ctx, '/api/v3/account', { omitZeroBalances: 'true' }, accountSchema),
      signedGet(ctx, '/sapi/v1/asset/get-funding-asset', {}, fundingSchema, 'POST'),
      signedGet(ctx, '/sapi/v1/simple-earn/flexible/position', page, flexibleSchema),
      signedGet(ctx, '/sapi/v1/simple-earn/locked/position', page, lockedSchema),
    ])
    if (flexible.total > flexible.rows.length || locked.total > locked.rows.length) {
      ctx.log.warn('Binance earn positions beyond the first page are not read', {
        flexible: flexible.total,
        locked: locked.total,
      })
    }

    const flexibleAssets = new Set(flexible.rows.map((row) => row.asset))
    const spot = account.balances.flatMap((row) => {
      const amount = sumDecimals(row.free, row.locked)
      const base = earnReceiptBase(row.asset)
      if (base === undefined) return [position(row.asset, amount, 'spot', 'spot')]
      // The earn endpoint already reports this position; the receipt would count it twice.
      return flexibleAssets.has(base) ? [] : [position(base, amount, 'lending', 'earn')]
    })
    const positions = nonZero([
      ...spot,
      ...funding.map((row) =>
        position(row.asset, sumDecimals(row.free, row.locked, row.freeze), 'spot', 'funding'),
      ),
      ...flexible.rows.map((row) => position(row.asset, row.totalAmount, 'lending', 'earn')),
      ...locked.rows.map((row) => position(row.asset, row.amount, 'staked', 'earn')),
    ])
    ctx.log.info('Binance balances read', { positions: positions.length })
    return venuePrices(ctx, positions)
  },
})
