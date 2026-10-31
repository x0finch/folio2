import type { ConnectionView, Holding, SourceInfo } from '@folio/shared'

import { Avatar } from '../../components/Avatar'
import { timeAgo } from '../../lib/time'
import { SourceIcon } from './SourceIcon'

const MAX_LOGOS = 5

/** One connection: what it is, how its last sync went, what it holds and its value. */
export function ConnectionRow({
  connection,
  source,
  holdings,
  valueUsd,
  syncing,
  now,
  formatMoney,
  onOpen,
}: {
  connection: ConnectionView
  source: SourceInfo | undefined
  holdings: Holding[]
  valueUsd: number | null
  syncing: boolean
  now: number
  formatMoney: (valueUsd: number) => string
  onOpen: () => void
}) {
  const status = syncing
    ? 'Syncing…'
    : connection.error
      ? `Failed: ${connection.error.message}`
      : connection.syncedAt
        ? `Synced ${timeAgo(connection.syncedAt, now)}`
        : 'Waiting for the first sync'
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="-mx-3 flex w-[calc(100%+1.5rem)] items-center gap-4 rounded-2xl px-3 py-3 text-left transition-colors hover:bg-card"
      >
        <SourceIcon source={source} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{connection.label}</span>
            <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {source?.label ?? connection.sourceId}
            </span>
          </div>
          <p
            className={`mt-0.5 truncate text-xs ${connection.error && !syncing ? 'text-loss' : 'text-muted-foreground'}`}
          >
            {status}
          </p>
          {holdings.length > 0 && (
            <div className="mt-2 flex items-center -space-x-1.5">
              {holdings.slice(0, MAX_LOGOS).map((holding) => (
                <Avatar
                  key={holding.assetId}
                  src={holding.logo}
                  label={holding.symbol}
                  size="sm"
                  className="ring-2 ring-background"
                />
              ))}
              {holdings.length > MAX_LOGOS && (
                <span className="grid h-5 min-w-5 place-items-center rounded-full bg-muted px-1 text-[9px] text-muted-foreground ring-2 ring-background">
                  +{holdings.length - MAX_LOGOS}
                </span>
              )}
            </div>
          )}
        </div>
        <span className="shrink-0 text-right tabular font-medium">
          {valueUsd === null ? '—' : formatMoney(valueUsd)}
        </span>
      </button>
    </li>
  )
}
