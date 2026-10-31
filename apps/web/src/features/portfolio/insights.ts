import { type Holding, type Portfolio, STABLECOIN_IDS } from '@folio/shared'

/** The day's best and worst movers by value change, and the stablecoin share. */
export function dayHighlights(portfolio: Portfolio) {
  const moved = portfolio.holdings.filter(
    (holding): holding is Holding & { changeUsd24h: number } =>
      holding.changeUsd24h !== null && holding.changeUsd24h !== 0,
  )
  const sorted = moved.toSorted((a, b) => b.changeUsd24h - a.changeUsd24h)
  const top = sorted[0]
  const worst = sorted.at(-1)
  const gross = portfolio.holdings.reduce((sum, h) => sum + Math.max(0, h.valueUsd ?? 0), 0)
  const stable = portfolio.holdings
    .filter((holding) => STABLECOIN_IDS.has(holding.assetId))
    .reduce((sum, h) => sum + Math.max(0, h.valueUsd ?? 0), 0)
  return {
    top: top && top.changeUsd24h > 0 ? top : null,
    worst: worst && worst.changeUsd24h < 0 ? worst : null,
    stableShare: gross > 0 ? stable / gross : null,
  }
}

export type HoldingSort = 'value' | 'change' | 'name'

const last = (value: number | null) => value ?? -Infinity

/** Sorts holdings; unknown values and changes go last. */
export function sortHoldings(holdings: Holding[], sort: HoldingSort): Holding[] {
  return holdings.toSorted((a, b) => {
    if (sort === 'name') return a.symbol.localeCompare(b.symbol)
    if (sort === 'change') return last(b.change24h) - last(a.change24h)
    return last(b.valueUsd) - last(a.valueUsd)
  })
}

/** Splits off holdings worth less than the dust threshold (and those with no value). */
export function splitDust(holdings: Holding[], dustUsd: number) {
  const visible: Holding[] = []
  const dust: Holding[] = []
  for (const holding of holdings) {
    if (holding.valueUsd !== null && Math.abs(holding.valueUsd) >= dustUsd) visible.push(holding)
    else dust.push(holding)
  }
  return { visible, dust }
}
