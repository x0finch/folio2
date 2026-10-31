import type { AssetRef } from './asset'

/** What a position is, which decides how it counts toward net worth. */
export type PositionKind =
  /** Held outright: wallet balance, exchange spot/funding balance. */
  | 'spot'
  /** Staked or locked, still owned. */
  | 'staked'
  /** Supplied to a lending protocol or an earn product. */
  | 'lending'
  /** Borrowed: counts negative. */
  | 'borrowed'
  /** Claimable rewards. */
  | 'reward'
  /** A perpetual futures position: counts its equity (margin + unrealized PnL), not notional. */
  | 'perp'

export interface PerpDetails {
  side: 'long' | 'short'
  /** Contract size in units of the asset, as a positive decimal string. */
  size: string
  entryPrice: number
  markPrice: number
  unrealizedPnlUsd: number
  marginUsd: number
  leverage?: number
  liquidationPrice?: number
}

/** One balance a source reports. Plugins return these; the app prices and aggregates them. */
export interface Position {
  asset: AssetRef
  /** Decimal string, never a float: balances can exceed float precision. */
  amount: string
  kind: PositionKind
  /** Where inside the connection it sits: a chain (`ethereum`), an account (`funding`). */
  location?: string
  /** A price the venue itself reports, used when the price feed has none. */
  priceUsd?: number
  /**
   * The USD value when the venue knows it better than amount × price (perp equity, LP
   * shares). Overrides the computed value.
   */
  valueUsd?: number
  perp?: PerpDetails
}

const DECIMAL = /^-?\d+(\.\d+)?$/

/** Whether `amount` is a plain decimal string (no exponent, no separators). */
export const isDecimal = (amount: string) => DECIMAL.test(amount)

/** Drops zero balances, which some upstreams return for every asset they list. */
export const nonZero = (positions: Position[]) =>
  positions.filter((position) => !/^-?0*(\.0*)?$/.test(position.amount))
