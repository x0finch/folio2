import type { Portfolio } from '@folio/shared'
import { NumberTicker } from '@folio/ui/components/motion/number-ticker'
import type { ReactNode } from 'react'

import { formatPercent } from '../../lib/format'
import { useWide } from '../../lib/use-media'
import { useMoney } from '../money/queries'
import { ChangePill } from './ChangePill'
import { dayHighlights } from './insights'

/** Net worth, its 24h change, the day's movers and the stablecoin share. */
export function Hero({ portfolio, chart }: { portfolio: Portfolio; chart?: ReactNode }) {
  const { format, convert } = useMoney()
  const wide = useWide()
  const { top, worst, stableShare } = dayHighlights(portfolio)

  return (
    <section className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] md:items-center">
      <div>
        <p className="text-xs text-muted-foreground">Total net worth</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <NumberTicker
            value={convert(portfolio.totalUsd)}
            decimals={wide ? 2 : 0}
            format={(value) => format(value / convert(1), { compact: !wide })}
            className="font-mono text-4xl font-medium tracking-tight md:text-5xl"
          />
          <ChangePill
            amount={portfolio.change24hUsd}
            ratio={portfolio.change24h}
            formatMoney={format}
          />
        </div>
        <dl className="mt-6 grid grid-cols-3 gap-4 text-xs">
          <Stat label="Top today">
            {top
              ? `${top.symbol} ${format(top.changeUsd24h, { signed: true, compact: true })}`
              : '—'}
          </Stat>
          <Stat label="Worst today">
            {worst
              ? `${worst.symbol} ${format(worst.changeUsd24h, { signed: true, compact: true })}`
              : '—'}
          </Stat>
          <Stat label="Stablecoins">{stableShare === null ? '—' : formatPercent(stableShare)}</Stat>
        </dl>
      </div>
      {chart}
    </section>
  )
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate font-mono tabular">{children}</dd>
    </div>
  )
}
