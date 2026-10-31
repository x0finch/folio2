import type { PerpPosition } from '@folio/shared'

import { Avatar } from '../../components/Avatar'
import { formatAmount } from '../../lib/format'
import { ChangeText } from './ChangePill'

/** Perp positions grouped by account, each group with its equity and PnL. */
export function PerpsList({
  perps,
  accounts,
  formatMoney,
}: {
  perps: PerpPosition[]
  accounts: Map<string, { icon: string | null; label: string }>
  formatMoney: (valueUsd: number, options?: { signed?: boolean }) => string
}) {
  const groups = new Map<string, PerpPosition[]>()
  for (const perp of perps) {
    groups.set(perp.connectionId, [...(groups.get(perp.connectionId) ?? []), perp])
  }
  if (!perps.length) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">No open perp positions.</p>
    )
  }
  return (
    <div className="flex flex-col gap-8">
      {[...groups].map(([connectionId, positions]) => {
        const account = accounts.get(connectionId)
        const equity = positions.reduce((sum, p) => sum + p.equityUsd, 0)
        const pnl = positions.reduce((sum, p) => sum + p.unrealizedPnlUsd, 0)
        const notional = positions.reduce((sum, p) => sum + p.notionalUsd, 0)
        return (
          <section key={connectionId}>
            <header className="flex items-center gap-2">
              <Avatar src={account?.icon} label={account?.label ?? '?'} size="sm" />
              <h3 className="font-medium">{account?.label ?? 'Account'}</h3>
            </header>
            <dl className="mt-3 grid grid-cols-3 gap-3 rounded-2xl bg-card p-4 text-xs">
              <div>
                <dt className="text-muted-foreground">Equity</dt>
                <dd className="mt-1 font-mono tabular">{formatMoney(equity)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Unrealized PnL</dt>
                <dd className={`mt-1 font-mono tabular ${pnl >= 0 ? 'text-gain' : 'text-loss'}`}>
                  {formatMoney(pnl, { signed: true })}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Notional</dt>
                <dd className="mt-1 font-mono tabular">{formatMoney(notional)}</dd>
              </div>
            </dl>
            <ul className="mt-2">
              {positions.map((perp) => (
                <li key={`${perp.assetId}-${perp.side}`} className="flex items-center gap-3 py-2.5">
                  <span
                    className={`w-20 shrink-0 rounded-md px-1.5 py-0.5 text-center text-[11px] font-medium ${
                      perp.side === 'long'
                        ? 'bg-gain-surface text-gain'
                        : 'bg-loss-surface text-loss'
                    }`}
                  >
                    {perp.leverage ? `${perp.leverage}x ` : ''}
                    {perp.side === 'long' ? 'Long' : 'Short'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-sm tabular">
                      {formatAmount(perp.size)} {perp.symbol}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Entry {formatMoney(perp.entryPrice)} · Mark {formatMoney(perp.markPrice)}
                      {perp.liquidationPrice !== null &&
                        ` · Liq. ${formatMoney(perp.liquidationPrice)}`}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-mono text-sm tabular">{formatMoney(perp.notionalUsd)}</p>
                    <ChangeText
                      amount={perp.unrealizedPnlUsd}
                      ratio={
                        perp.equityUsd > 0
                          ? perp.unrealizedPnlUsd / (perp.equityUsd - perp.unrealizedPnlUsd || 1)
                          : null
                      }
                      formatMoney={formatMoney}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
      <p className="text-xs text-muted-foreground">
        Net worth counts each account's equity (margin plus unrealized PnL), not the notional size.
      </p>
    </div>
  )
}
