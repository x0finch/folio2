import { Tabs, TabsList, TabsTrigger } from '@folio/ui/components/motion/tabs'
import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { ChevronDown, Plus } from 'lucide-react'
import { useState } from 'react'

import { PageHeader } from '../../components/PageHeader'
import { connectionsQuery, portfolioQuery } from '../../features/connections/queries'
import { useMoney } from '../../features/money/queries'
import { Hero } from '../../features/portfolio/Hero'
import { HoldingRow } from '../../features/portfolio/HoldingRow'
import { type HoldingSort, sortHoldings, splitDust } from '../../features/portfolio/insights'
import { PerpsList } from '../../features/portfolio/PerpsList'
import { useAccountIcons } from '../../features/portfolio/use-accounts'
import { SyncPill } from '../../features/sync/SyncPill'

export const Route = createFileRoute('/_app/')({ component: OverviewPage })

const SORTS: { value: HoldingSort; label: string }[] = [
  { value: 'value', label: 'Value' },
  { value: 'change', label: '24h change' },
  { value: 'name', label: 'Name' },
]

function OverviewPage() {
  const { data: portfolio, isPending } = useQuery(portfolioQuery)
  const { data: connections } = useQuery(connectionsQuery)
  const { format, settings } = useMoney()
  const accounts = useAccountIcons()
  const [tab, setTab] = useState<'tokens' | 'perps'>('tokens')
  const [sort, setSort] = useState<HoldingSort>('value')
  const [showDust, setShowDust] = useState(false)

  const header = (
    <PageHeader
      title="Overview"
      subtitle={
        connections?.length
          ? `Live portfolio across ${connections.length} ${connections.length === 1 ? 'source' : 'sources'}`
          : 'Your portfolio at a glance'
      }
      actions={<SyncPill />}
    />
  )

  if (isPending || !portfolio) {
    return (
      <>
        {header}
        <div className="h-28 w-72 animate-pulse rounded-2xl bg-card" />
        <div className="mt-10 flex flex-col gap-3">
          {[0, 1, 2, 3].map((key) => (
            <div key={key} className="h-14 animate-pulse rounded-2xl bg-card" />
          ))}
        </div>
      </>
    )
  }

  if (connections?.length === 0) {
    return (
      <>
        {header}
        <div className="flex flex-col items-center rounded-3xl border border-dashed border-border-strong px-6 py-16 text-center">
          <h2 className="text-lg font-medium">Nothing to show yet</h2>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Add a wallet, an exchange or holdings by hand and your net worth appears here.
          </p>
          <Link
            to="/accounts"
            className="mt-6 inline-flex h-10 items-center gap-2 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground"
          >
            <Plus className="size-4" /> Add an account
          </Link>
        </div>
      </>
    )
  }

  const { visible, dust } = splitDust(sortHoldings(portfolio.holdings, sort), settings.dustUsd)
  const spotTotal = portfolio.holdings.reduce((sum, h) => sum + (h.valueUsd ?? 0), 0)
  const perpTotal = portfolio.perps.reduce((sum, p) => sum + p.equityUsd, 0)

  return (
    <>
      {header}
      <Hero portfolio={portfolio} />
      <div className="mt-10 flex items-center justify-between gap-3">
        <Tabs value={tab} onValueChange={(value) => setTab(value === 'perps' ? 'perps' : 'tokens')}>
          <TabsList>
            <TabsTrigger value="tokens">Tokens</TabsTrigger>
            <TabsTrigger value="perps">Perps</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-3">
          {tab === 'tokens' && (
            <label className="relative text-xs text-muted-foreground">
              <span className="sr-only">Sort by</span>
              <select
                value={sort}
                onChange={(event) =>
                  setSort(SORTS.find((s) => s.value === event.target.value)?.value ?? 'value')
                }
                className="h-8 appearance-none rounded-full border border-border bg-card pr-7 pl-3 text-xs text-foreground"
              >
                {SORTS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute top-2 right-2 size-4" />
            </label>
          )}
          <span className="hidden font-mono text-sm text-muted-foreground tabular sm:inline">
            {format(tab === 'tokens' ? spotTotal : perpTotal)}
          </span>
        </div>
      </div>
      <div className="mt-4">
        {tab === 'tokens' ? (
          <>
            <ul>
              {(showDust ? [...visible, ...dust] : visible).map((holding) => (
                <HoldingRow
                  key={holding.assetId}
                  holding={holding}
                  sourceIcons={accounts}
                  formatMoney={format}
                />
              ))}
            </ul>
            {dust.length > 0 && (
              <button
                type="button"
                onClick={() => setShowDust((shown) => !shown)}
                className="mt-3 text-sm text-muted-foreground hover:text-foreground"
              >
                {showDust
                  ? 'Hide small holdings'
                  : `${dust.length} small ${dust.length === 1 ? 'holding' : 'holdings'} under ${format(settings.dustUsd)}`}
              </button>
            )}
            {!visible.length && !dust.length && (
              <p className="py-10 text-center text-sm text-muted-foreground">
                Waiting for the first sync to finish…
              </p>
            )}
          </>
        ) : (
          <PerpsList perps={portfolio.perps} accounts={accounts} formatMoney={format} />
        )}
      </div>
    </>
  )
}
