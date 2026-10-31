import type { Holding, HoldingSource, PerpPosition, Portfolio } from '@folio/shared'
import { type PerpDetails, type PositionKind, canonicalAssetId } from '@folio/sources'
import { Big } from 'big.js'

import type { Quote } from './defillama'

/** A stored position, as the aggregation needs it. */
export interface PositionInput {
  connectionId: string
  assetId: string
  symbol: string
  name: string | null
  logo: string | null
  amount: string
  kind: PositionKind
  location: string | null
  priceUsd: number | null
  valueUsd: number | null
  perp: PerpDetails | null
  updatedAt: number
}

interface Draft {
  holding: Holding
  amount: Big
  valued: boolean
}

/**
 * Turns positions into the portfolio: positions of the same (canonical) asset merge into one
 * holding; feed prices win over venue prices; borrowed amounts count negative; perps count
 * their equity and are listed apart.
 */
export function aggregate(positions: PositionInput[], quotes: Map<string, Quote>): Portfolio {
  const drafts = new Map<string, Draft>()
  const perps: PerpPosition[] = []
  let updatedAt: number | null = null

  for (const position of positions) {
    updatedAt = Math.max(updatedAt ?? 0, position.updatedAt)
    const assetId = canonicalAssetId(position.assetId)
    const quote = quotes.get(assetId) ?? quotes.get(position.assetId)

    if (position.kind === 'perp') {
      if (position.perp) perps.push(toPerp(position, position.perp, assetId))
      continue
    }

    const sign = position.kind === 'borrowed' ? -1 : 1
    const amount = new Big(position.amount).times(sign)
    const price = quote?.priceUsd ?? position.priceUsd
    const valueUsd =
      position.valueUsd !== null
        ? position.valueUsd * sign
        : price === null
          ? null
          : amount.toNumber() * price

    let draft = drafts.get(assetId)
    if (!draft) {
      draft = {
        amount: new Big(0),
        valued: false,
        holding: {
          assetId,
          symbol: position.symbol.toUpperCase(),
          name: position.name,
          logo: position.logo,
          amount: '0',
          priceUsd: price,
          valueUsd: null,
          change24h: quote?.change24h ?? null,
          changeUsd24h: null,
          share: null,
          sources: [],
        },
      }
      drafts.set(assetId, draft)
    }
    draft.amount = draft.amount.plus(amount)
    draft.holding.name ??= position.name
    draft.holding.logo ??= position.logo
    draft.holding.priceUsd ??= price
    if (valueUsd !== null) {
      draft.holding.valueUsd = (draft.holding.valueUsd ?? 0) + valueUsd
      draft.valued = true
    }
    const source: HoldingSource = {
      connectionId: position.connectionId,
      kind: position.kind,
      location: position.location,
      amount: amount.toString(),
      valueUsd,
    }
    draft.holding.sources.push(source)
  }

  const holdings = [...drafts.values()].map(({ holding, amount }) => {
    holding.amount = amount.toString()
    const { valueUsd, change24h } = holding
    // Value now is value 24h ago × (1 + change): the change in value is value × c / (1 + c).
    holding.changeUsd24h =
      valueUsd !== null && change24h !== null ? (valueUsd * change24h) / (1 + change24h) : null
    return holding
  })

  const gross = holdings.reduce((sum, holding) => sum + Math.max(0, holding.valueUsd ?? 0), 0)
  for (const holding of holdings) {
    holding.share =
      gross > 0 && holding.valueUsd !== null ? Math.max(0, holding.valueUsd) / gross : null
  }
  holdings.sort((a, b) => (b.valueUsd ?? -Infinity) - (a.valueUsd ?? -Infinity))

  const spotTotal = holdings.reduce((sum, holding) => sum + (holding.valueUsd ?? 0), 0)
  const perpTotal = perps.reduce((sum, perp) => sum + perp.equityUsd, 0)
  const change24hUsd = holdings.reduce((sum, holding) => sum + (holding.changeUsd24h ?? 0), 0)
  const totalUsd = spotTotal + perpTotal
  const before = totalUsd - change24hUsd

  return {
    totalUsd,
    change24hUsd,
    change24h: before > 0 ? change24hUsd / before : null,
    holdings,
    perps,
    updatedAt,
  }
}

function toPerp(position: PositionInput, perp: PerpDetails, assetId: string): PerpPosition {
  return {
    connectionId: position.connectionId,
    assetId,
    symbol: position.symbol.toUpperCase(),
    side: perp.side,
    size: perp.size,
    entryPrice: perp.entryPrice,
    markPrice: perp.markPrice,
    notionalUsd: Number(perp.size) * perp.markPrice,
    unrealizedPnlUsd: perp.unrealizedPnlUsd,
    equityUsd: position.valueUsd ?? perp.marginUsd + perp.unrealizedPnlUsd,
    leverage: perp.leverage ?? null,
    liquidationPrice: perp.liquidationPrice ?? null,
  }
}
