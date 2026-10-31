import type { Portfolio } from '@folio/shared'

export interface Slice {
  id: string
  name: string
  valueUsd: number
}

/** The largest `top` slices by value, the rest summed into "Other". Negative values are left out. */
export function topSlices(slices: Slice[], top: number): Slice[] {
  const positive = slices
    .filter((slice) => slice.valueUsd > 0)
    .toSorted((a, b) => b.valueUsd - a.valueUsd)
  if (positive.length <= top + 1) return positive
  const rest = positive.slice(top).reduce((sum, slice) => sum + slice.valueUsd, 0)
  return [...positive.slice(0, top), { id: 'other', name: 'Other', valueUsd: rest }]
}

export function byAsset(portfolio: Portfolio): Slice[] {
  return portfolio.holdings.map((holding) => ({
    id: holding.assetId,
    name: holding.symbol,
    valueUsd: holding.valueUsd ?? 0,
  }))
}

/** Value per account: holdings split by where they are held, plus perp equity. */
export function byAccount(portfolio: Portfolio, labels: Map<string, string>): Slice[] {
  const totals = new Map<string, number>()
  for (const holding of portfolio.holdings) {
    for (const source of holding.sources) {
      totals.set(
        source.connectionId,
        (totals.get(source.connectionId) ?? 0) + (source.valueUsd ?? 0),
      )
    }
  }
  for (const perp of portfolio.perps) {
    totals.set(perp.connectionId, (totals.get(perp.connectionId) ?? 0) + perp.equityUsd)
  }
  return [...totals].map(([id, valueUsd]) => ({ id, name: labels.get(id) ?? 'Account', valueUsd }))
}
