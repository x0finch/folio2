import { z } from 'zod'

/** Currencies values can be shown in. All values are stored in USD and converted for display. */
export const DISPLAY_CURRENCIES = [
  'USD',
  'EUR',
  'GBP',
  'JPY',
  'CNY',
  'HKD',
  'SGD',
  'KRW',
  'AUD',
  'CAD',
  'CHF',
  'BTC',
  'ETH',
] as const
export type DisplayCurrency = (typeof DISPLAY_CURRENCIES)[number]

export const settingsSchema = z.object({
  currency: z.enum(DISPLAY_CURRENCIES),
  /** Holdings worth less than this (USD) are hidden unless the user shows them. */
  dustUsd: z.number().min(0).max(1000),
})
export type Settings = z.output<typeof settingsSchema>
export const DEFAULT_SETTINGS: Settings = { currency: 'USD', dustUsd: 1 }

/** `GET /api/rates`: units of each display currency per 1 USD. */
export type RatesResponse = Partial<Record<DisplayCurrency, number>>

export interface HoldingSource {
  connectionId: string
  kind: 'spot' | 'staked' | 'lending' | 'borrowed' | 'reward'
  location: string | null
  amount: string
  valueUsd: number | null
}

/** One asset across every connection. */
export interface Holding {
  assetId: string
  symbol: string
  name: string | null
  logo: string | null
  /** Net amount (borrowed counts negative), decimal string. */
  amount: string
  priceUsd: number | null
  valueUsd: number | null
  /** 24h price change as a ratio, when known. */
  change24h: number | null
  /** What the value changed by over 24h at today's amount. */
  changeUsd24h: number | null
  /** Share of the gross positive value, 0..1. */
  share: number | null
  sources: HoldingSource[]
}

export interface PerpPosition {
  connectionId: string
  assetId: string
  symbol: string
  side: 'long' | 'short'
  size: string
  entryPrice: number
  markPrice: number
  notionalUsd: number
  unrealizedPnlUsd: number
  /** Margin + unrealized PnL: what counts toward net worth. */
  equityUsd: number
  leverage: number | null
  liquidationPrice: number | null
}

export interface Portfolio {
  totalUsd: number
  change24hUsd: number
  /** Change ratio against the value 24h ago, when computable. */
  change24h: number | null
  holdings: Holding[]
  perps: PerpPosition[]
  /** Newest position update across connections. */
  updatedAt: number | null
}
