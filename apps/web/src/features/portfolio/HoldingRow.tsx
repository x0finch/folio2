import type { Holding } from '@folio/shared'
import { Link } from '@tanstack/react-router'

import { Avatar } from '../../components/Avatar'
import { formatAmount } from '../../lib/format'
import { ChangeText } from './ChangePill'

const MAX_SOURCE_LOGOS = 3

/** One asset across every account: logo, name, where it is held, amount, value, 24h change. */
export function HoldingRow({
  holding,
  sourceIcons,
  formatMoney,
}: {
  holding: Holding
  /** Logo URL (or null) and label per connection id. */
  sourceIcons: Map<string, { icon: string | null; label: string }>
  formatMoney: (valueUsd: number, options?: { signed?: boolean }) => string
}) {
  const held = [...new Set(holding.sources.map((source) => source.connectionId))]
  return (
    <li>
      <Link
        to="/assets/$assetId"
        params={{ assetId: holding.assetId }}
        className="-mx-3 flex items-center gap-3 rounded-2xl px-3 py-2.5 transition-colors hover:bg-card"
      >
        <Avatar src={holding.logo} label={holding.symbol} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{holding.name ?? holding.symbol}</span>
            <span className="flex shrink-0 items-center -space-x-1">
              {held.slice(0, MAX_SOURCE_LOGOS).map((id) => {
                const source = sourceIcons.get(id)
                return (
                  <Avatar
                    key={id}
                    src={source?.icon}
                    label={source?.label ?? '?'}
                    size="sm"
                    className="size-4 ring-2 ring-background"
                  />
                )
              })}
              {held.length > MAX_SOURCE_LOGOS && (
                <span className="pl-2 text-[10px] text-muted-foreground">
                  +{held.length - MAX_SOURCE_LOGOS}
                </span>
              )}
            </span>
          </div>
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground tabular">
            {formatAmount(holding.amount)} {holding.symbol}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-mono font-medium tabular">
            {holding.valueUsd === null ? '—' : formatMoney(holding.valueUsd)}
          </p>
          <ChangeText
            amount={holding.changeUsd24h}
            ratio={holding.change24h}
            formatMoney={formatMoney}
          />
        </div>
      </Link>
    </li>
  )
}
