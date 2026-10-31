import type { HistoryRange } from '@folio/shared'
import { LineChart } from '@folio/ui/components/charts/line-chart'

import { useMoney } from '../money/queries'

const DAY_LABEL = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' })
const HOUR_LABEL = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
})

/**
 * Value over time as an area chart. Green when the period ended higher than it started, red
 * when lower; colours come from the theme tokens.
 */
export function TrendChart({
  points,
  range,
  label,
  className,
}: {
  points: { t: number; v: number }[]
  range: HistoryRange
  label: string
  className?: string
}) {
  const { format, convert } = useMoney()
  if (points.length < 2) {
    return (
      <div
        className={`grid min-h-40 place-items-center rounded-2xl border border-dashed border-border-strong px-6 text-center text-sm text-muted-foreground ${className ?? ''}`}
      >
        The trend appears after a few syncs.
      </div>
    )
  }
  const short = range === '7d'
  const categories = points.map((point) => (short ? HOUR_LABEL : DAY_LABEL).format(point.t))
  // The chart keys points by label, so repeats get invisible zero-width suffixes.
  const seen = new Map<string, number>()
  const unique = categories.map((text) => {
    const count = seen.get(text) ?? 0
    seen.set(text, count + 1)
    return text + '\u200b'.repeat(count)
  })
  const up = (points.at(-1)?.v ?? 0) >= (points[0]?.v ?? 0)
  return (
    <LineChart
      className={className}
      label={label}
      variant="area"
      curve="monotone"
      categories={unique}
      series={[
        {
          id: 'value',
          name: 'Value',
          color: up ? 'var(--gain)' : 'var(--loss)',
          values: points.map((point) => convert(point.v)),
        },
      ]}
      formatValue={(value) => format(value / convert(1))}
      formatTick={(value) => format(value / convert(1), { compact: true })}
    />
  )
}
