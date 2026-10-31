import type { HistoryRange } from '@folio/shared'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { PageHeader } from '../../components/PageHeader'
import { connectionsQuery, portfolioQuery } from '../../features/connections/queries'
import { byAccount, byAsset } from '../../features/history/allocation'
import { AllocationCard } from '../../features/history/AllocationCard'
import { historyQuery } from '../../features/history/queries'
import { RangeTabs } from '../../features/history/RangeTabs'
import { TrendChart } from '../../features/history/TrendChart'
import { useMoney } from '../../features/money/queries'
import { ChangePill } from '../../features/portfolio/ChangePill'

export const Route = createFileRoute('/_app/insights')({ component: InsightsPage })

function InsightsPage() {
  const [range, setRange] = useState<HistoryRange>('30d')
  const { data: history } = useQuery(historyQuery(range))
  const { data: portfolio } = useQuery(portfolioQuery)
  const { data: connections = [] } = useQuery(connectionsQuery)
  const { format } = useMoney()
  const points = history?.points ?? []
  const first = points[0]?.v
  const last = points.at(-1)?.v
  const change =
    first !== undefined && last !== undefined && points.length > 1 ? last - first : null

  return (
    <>
      <PageHeader title="Insights" subtitle="History and allocation over time" />
      <section>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-medium">Net worth</h2>
            {change !== null && first !== undefined && (
              <ChangePill
                amount={change}
                ratio={first > 0 ? change / first : null}
                formatMoney={format}
                size="sm"
              />
            )}
          </div>
          <RangeTabs value={range} onChange={setRange} />
        </div>
        {history ? (
          <TrendChart points={points} range={range} label="Net worth over time" />
        ) : (
          <div className="h-64 animate-pulse rounded-2xl bg-card" />
        )}
      </section>
      {portfolio && (
        <div className="mt-10 grid gap-4 lg:grid-cols-2">
          <AllocationCard title="By asset" slices={byAsset(portfolio)} />
          <AllocationCard
            title="By account"
            slices={byAccount(portfolio, new Map(connections.map((c) => [c.id, c.label])))}
          />
        </div>
      )}
    </>
  )
}
