import { HISTORY_RANGES, type HistoryRange } from '@folio/shared'
import { Tabs, TabsList, TabsTrigger } from '@folio/ui/components/motion/tabs'

const LABEL: Record<HistoryRange, string> = {
  '7d': '7D',
  '30d': '30D',
  '90d': '90D',
  '1y': '1Y',
  all: 'All',
}

export function RangeTabs({
  value,
  onChange,
}: {
  value: HistoryRange
  onChange: (range: HistoryRange) => void
}) {
  return (
    <Tabs
      value={value}
      onValueChange={(next) => onChange(HISTORY_RANGES.find((range) => range === next) ?? '30d')}
      variant="segment"
    >
      <TabsList>
        {HISTORY_RANGES.map((range) => (
          <TabsTrigger key={range} value={range}>
            {LABEL[range]}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
