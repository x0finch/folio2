import type { HistoryRange } from '@folio/shared'
import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { useState } from 'react'

import { Avatar } from '../../components/Avatar'
import { portfolioQuery } from '../../features/connections/queries'
import { assetHistoryQuery } from '../../features/history/queries'
import { RangeTabs } from '../../features/history/RangeTabs'
import { TrendChart } from '../../features/history/TrendChart'
import { useMoney } from '../../features/money/queries'
import { ChangePill } from '../../features/portfolio/ChangePill'
import { useAccountIcons } from '../../features/portfolio/use-accounts'
import { formatAmount, formatPercent } from '../../lib/format'

export const Route = createFileRoute('/_app/assets/$assetId')({ component: AssetPage })

const KIND_LABEL = {
  spot: 'Balance',
  staked: 'Staked',
  lending: 'Lent',
  borrowed: 'Borrowed',
  reward: 'Rewards',
} as const

function AssetPage() {
  const { assetId } = Route.useParams()
  const { data: portfolio } = useQuery(portfolioQuery)
  const { format } = useMoney()
  const accounts = useAccountIcons()
  const holding = portfolio?.holdings.find((candidate) => candidate.assetId === assetId)

  return (
    <>
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Overview
      </Link>
      {!portfolio ? (
        <div className="mt-6 h-24 w-64 animate-pulse rounded-2xl bg-card" />
      ) : !holding ? (
        <p className="mt-6 text-sm text-muted-foreground">You don't hold this asset any more.</p>
      ) : (
        <>
          <header className="mt-6 flex items-center gap-4">
            <Avatar src={holding.logo} label={holding.symbol} size="lg" className="size-12" />
            <div>
              <h1 className="font-serif text-4xl tracking-tight">
                {holding.name ?? holding.symbol}
              </h1>
              <p className="text-sm text-muted-foreground">
                {holding.symbol}
                {holding.priceUsd !== null && ` · ${format(holding.priceUsd)}`}
              </p>
            </div>
          </header>
          <section className="mt-8">
            <p className="text-xs text-muted-foreground">Your holding</p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <span className="font-mono text-4xl font-medium tracking-tight tabular">
                {holding.valueUsd === null ? '—' : format(holding.valueUsd)}
              </span>
              {holding.changeUsd24h !== null && (
                <ChangePill
                  amount={holding.changeUsd24h}
                  ratio={holding.change24h}
                  formatMoney={format}
                />
              )}
            </div>
            <p className="mt-2 font-mono text-sm text-muted-foreground tabular">
              {formatAmount(holding.amount)} {holding.symbol}
              {holding.share !== null && ` · ${formatPercent(holding.share)} of portfolio`}
            </p>
          </section>
          <AssetTrend assetId={assetId} />
          <section className="mt-10">
            <h2 className="mb-2 text-sm font-medium">Where you hold it</h2>
            <ul>
              {holding.sources.map((source, index) => {
                const account = accounts.get(source.connectionId)
                return (
                  <li
                    // A connection can hold the same asset in several places (chains, accounts).
                    key={`${source.connectionId}-${source.kind}-${source.location ?? index}`}
                    className="flex items-center gap-3 border-b border-border py-3 last:border-0"
                  >
                    <Avatar src={account?.icon} label={account?.label ?? '?'} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{account?.label ?? 'Account'}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {KIND_LABEL[source.kind]}
                        {source.location && ` · ${source.location}`}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-mono text-sm tabular">
                        {source.valueUsd === null ? '—' : format(source.valueUsd)}
                      </p>
                      <p className="font-mono text-xs text-muted-foreground tabular">
                        {formatAmount(source.amount)} {holding.symbol}
                      </p>
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>
        </>
      )}
    </>
  )
}

function AssetTrend({ assetId }: { assetId: string }) {
  const [range, setRange] = useState<HistoryRange>('30d')
  const { data } = useQuery(assetHistoryQuery(assetId, range))
  return (
    <section className="mt-10">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">Value over time</h2>
        <RangeTabs value={range} onChange={setRange} />
      </div>
      {data ? (
        <TrendChart points={data.points} range={range} label="Value of this asset over time" />
      ) : (
        <div className="h-48 animate-pulse rounded-2xl bg-card" />
      )}
    </section>
  )
}
