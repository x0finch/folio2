export interface Point {
  t: number
  v: number
}

/**
 * At most `max` points: the series is cut into equal time buckets and each keeps its last
 * point. The first and last points always survive, and time stays increasing.
 */
export function downsample(points: readonly Point[], max: number): Point[] {
  if (points.length <= max || max < 2) return [...points]
  const first = points[0]!
  const last = points.at(-1)!
  const span = last.t - first.t
  const buckets = max - 1
  const kept = new Map<number, Point>()
  for (const point of points.slice(1, -1)) {
    const bucket = Math.min(buckets - 1, Math.floor(((point.t - first.t) / span) * buckets))
    kept.set(bucket, point)
  }
  // The final bucket's last point is replaced by the true last point.
  kept.delete(buckets - 1)
  return [first, ...[...kept.values()].toSorted((a, b) => a.t - b.t), last]
}
