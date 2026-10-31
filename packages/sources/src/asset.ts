/**
 * How a position names its asset. Pricing and aggregation key on `id`:
 *
 * - `coingecko:<id>` for assets with a CoinGecko id (native coins, exchange tickers);
 * - `<chain>:<address>` for tokens known only by their contract (lowercase for EVM).
 *
 * Positions of the same `id` merge into one holding across connections.
 */
export interface AssetRef {
  id: string
  symbol: string
  name?: string
  /** Logo URL when the upstream provides one. */
  logo?: string
}

export const coingeckoId = (id: string) => `coingecko:${id}`

export const tokenId = (chain: string, address: string) =>
  `${chain}:${address.startsWith('0x') ? address.toLowerCase() : address}`

/** Splits an asset id into its namespace (`coingecko` or a chain) and the rest. */
export function parseAssetId(id: string): { namespace: string; key: string } {
  const at = id.indexOf(':')
  if (at <= 0 || at === id.length - 1) throw new Error(`Invalid asset id: ${id}`)
  return { namespace: id.slice(0, at), key: id.slice(at + 1) }
}
