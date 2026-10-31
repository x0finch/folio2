import { Big } from 'big.js'
import { z } from 'zod'

import { defineSource, secret, type SourceContext } from '../define'
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
import { okxHeaders } from './sign'

const BASE = 'https://www.okx.com'
/** The quote currency venue prices are read against; USDT is treated as one US dollar. */
const QUOTE = 'USDT'

/** Every OKX answer: `code` "0" on success, an error code otherwise, with `data`. */
const envelope = z.object({ code: z.string(), data: z.unknown() })

const tradingSchema = z.array(
  z.object({
    details: z.array(z.object({ ccy: z.string(), eq: venueDecimal, eqUsd: optionalVenueDecimal })),
  }),
)
const fundingSchema = z.array(z.object({ ccy: z.string(), bal: venueDecimal }))
const tickersSchema = z.array(z.object({ instId: z.string(), last: optionalVenueDecimal }))

const config = z.object({
  apiKey: apiKeyField(),
  apiSecret: apiSecretField(),
  passphrase: secret({ title: 'Passphrase', placeholder: 'The passphrase you set for this key' }),
})
type Config = z.output<typeof config>

/** OKX error codes worth a clear message (https://www.okx.com/docs-v5/en/#error-code). */
const mapError: ErrorCodeMapper = (code) => {
  switch (code) {
    case '50111':
    case '50119':
      return new SourceError('unauthorized', 'OKX does not know this API key')
    case '50113':
      return new SourceError(
        'unauthorized',
        'OKX rejected the signature: the API secret does not belong to this API key',
      )
    case '50104':
    case '50105':
      return new SourceError('unauthorized', 'OKX rejected the passphrase for this API key')
    case '50110':
      return new SourceError(
        'unauthorized',
        "OKX refused this server's IP: the key is limited to other IP addresses",
      )
    case '50120':
      return new SourceError('unauthorized', 'The OKX API key lacks the "Read" permission')
    case '50101':
      return new SourceError(
        'unauthorized',
        'This OKX API key belongs to another environment (demo trading or another region)',
      )
    case '50100':
      return new SourceError('unauthorized', 'OKX froze this API key')
    case '50102':
      return new SourceError('upstream', 'OKX rejected the request time; it will be retried')
    case '50011':
    case '50061':
      return new SourceError('rate_limited', 'OKX rate limited the sync')
    default:
      return undefined
  }
}

/** Fetches an OKX endpoint (signed when `signed`) and returns its `data` after checking `code`. */
async function call<T extends z.ZodType>(
  ctx: SourceContext<Config>,
  requestPath: string,
  schema: T,
  signed = true,
): Promise<z.output<T>> {
  const headers = signed
    ? await okxHeaders({ timestamp: ctx.now.toISOString(), method: 'GET', requestPath }, ctx.config)
    : undefined
  const fetch = withErrorCodes(ctx.fetch, mapError)
  const body = await fetchJson(fetch, `${BASE}${requestPath}`, envelope, { headers })
  if (body.code !== '0') throwForCode(body.code, mapError, 'OKX')
  const data = schema.safeParse(body.data)
  if (!data.success) {
    throw new SourceError('upstream', 'OKX answered an unexpected shape', { cause: data.error })
  }
  return data.data
}

/** USD prices for `cex:` assets the account didn't price, from OKX's USDT spot pairs. */
async function venuePrices(ctx: SourceContext<Config>, positions: Position[]) {
  const missing = positions.some((p) => p.asset.id.startsWith('cex:') && p.priceUsd === undefined)
  if (!missing) return positions
  const tickers = await call(ctx, '/api/v5/market/tickers?instType=SPOT', tickersSchema, false)
  const byPair = new Map(tickers.map((row) => [row.instId, row.last]))
  return positions.map((p) => {
    if (!p.asset.id.startsWith('cex:') || p.priceUsd !== undefined) return p
    const last = byPair.get(`${p.asset.symbol}-${QUOTE}`)
    return last ? { ...p, priceUsd: Number(last) } : p
  })
}

/**
 * OKX trading (unified) account and funding account balances, read with a read-only API key.
 * Coin equity in the trading account includes the unrealized PnL of derivatives margined in that
 * coin; the derivative positions themselves are not listed yet.
 */
export const okx = defineSource({
  id: 'okx',
  kind: 'exchange',
  label: 'OKX',
  description: 'Trading and funding account balances through a read-only API key',
  icon: 'https://icons.llamao.fi/icons/protocols/okx?w=48&h=48',
  config: config.meta({
    description:
      'Create an API key with only the "Read" permission (Profile → API keys). Never enable trading or withdrawals for Folio.',
  }),
  // Trading balance, funding balance, and one spot ticker list for unknown currencies.
  maxRequests: () => 3,
  defaultLabel: ({ apiKey }) => keyLabel('OKX', apiKey),
  validate: async (ctx) => {
    await call(ctx, '/api/v5/account/balance', tradingSchema)
  },
  fetchPositions: async (ctx) => {
    const [trading, funding] = await Promise.all([
      call(ctx, '/api/v5/account/balance', tradingSchema),
      call(ctx, '/api/v5/asset/balances', fundingSchema),
    ])
    const details = trading.flatMap((account) => account.details)
    const prices = new Map(details.map((row) => [row.ccy, unitPrice(row.eqUsd, row.eq)]))
    const positions = nonZero([
      ...details.map((row): Position => {
        const equity = new Big(row.eq)
        return {
          asset: tickerAsset(row.ccy),
          amount: equity.abs().toFixed(),
          // Negative equity is a loan in the multi-currency and portfolio margin modes.
          kind: equity.lt(0) ? 'borrowed' : 'spot',
          location: 'trading',
          priceUsd: prices.get(row.ccy),
        }
      }),
      ...funding.map((row): Position => ({
        asset: tickerAsset(row.ccy),
        amount: row.bal,
        kind: 'spot',
        location: 'funding',
        priceUsd: prices.get(row.ccy),
      })),
    ])
    ctx.log.info('OKX balances read', { positions: positions.length })
    return venuePrices(ctx, positions)
  },
})
