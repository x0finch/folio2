import { formatPercent } from '../../lib/format'

/** "+$1,234.00 1.20%" on a gain or loss surface. */
export function ChangePill({
  amount,
  ratio,
  formatMoney,
  size = 'md',
}: {
  amount: number
  ratio: number | null
  formatMoney: (valueUsd: number, options?: { signed?: boolean }) => string
  size?: 'sm' | 'md'
}) {
  const tone =
    amount > 0
      ? 'bg-gain-surface text-gain'
      : amount < 0
        ? 'bg-loss-surface text-loss'
        : 'bg-muted text-muted-foreground'
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md font-mono tabular ${tone} ${
        size === 'sm' ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-1 text-xs'
      }`}
    >
      {formatMoney(amount, { signed: true })}
      {ratio !== null && <span>{formatPercent(Math.abs(ratio))}</span>}
    </span>
  )
}

/** Small signed change text for list rows. */
export function ChangeText({
  amount,
  ratio,
  formatMoney,
}: {
  amount: number | null
  ratio: number | null
  formatMoney: (valueUsd: number, options?: { signed?: boolean }) => string
}) {
  if (amount === null) return <span className="text-xs text-muted-foreground">—</span>
  const tone = amount > 0 ? 'text-gain' : amount < 0 ? 'text-loss' : 'text-muted-foreground'
  return (
    <span className={`font-mono text-xs tabular ${tone}`}>
      {formatMoney(amount, { signed: true })}
      {ratio !== null && ` ${formatPercent(ratio, { signed: true })}`}
    </span>
  )
}
