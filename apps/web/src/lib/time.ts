const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
]

/** "just now", "5 minutes ago", "yesterday". */
export function timeAgo(time: number, now: number): string {
  const elapsed = now - time
  if (elapsed < 45_000) return 'just now'
  for (const [unit, size] of UNITS) {
    if (elapsed >= size || unit === 'minute') {
      return relative.format(-Math.max(1, Math.round(elapsed / size)), unit)
    }
  }
  return 'just now'
}
