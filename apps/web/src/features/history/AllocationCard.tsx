import { DonutChart } from '@folio/ui/components/charts/donut-chart'

import { useMoney } from '../money/queries'
import { type Slice, topSlices } from './allocation'

const COLORS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6']
const TOP = 6

/** A donut of where the value sits, the biggest slices named and the rest as "Other". */
export function AllocationCard({ title, slices }: { title: string; slices: Slice[] }) {
  const { format, convert } = useMoney()
  const segments = topSlices(slices, TOP).map((slice, index) => ({
    id: slice.id,
    name: slice.name,
    // "Other" in a neutral colour; named slices take the chart palette in order.
    color:
      slice.id === 'other' ? 'var(--muted-foreground)' : `var(${COLORS[index % COLORS.length]})`,
    value: convert(slice.valueUsd),
  }))
  return (
    <section className="rounded-3xl border border-border bg-card/40 p-5">
      <h2 className="mb-4 text-sm font-medium">{title}</h2>
      {segments.length ? (
        <DonutChart
          label={title}
          segments={segments}
          formatValue={(value) => format(value / convert(1), { compact: true })}
        />
      ) : (
        <p className="py-8 text-center text-sm text-muted-foreground">Nothing priced yet.</p>
      )}
    </section>
  )
}
