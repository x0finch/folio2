/** 长窗 min-max 降采样 —— 仅服务端用(FOL-46)。manual 账本现算走这里;快照账户走 SQL。 */

export interface MinMaxPoint {
  t: number;
  total: number;
}

const TARGET_MAX_POINTS = 40;

export function minMaxDownsampleHistory(
  points: readonly MinMaxPoint[],
  buckets = TARGET_MAX_POINTS,
): MinMaxPoint[] {
  if (points.length <= 1) return [...points];
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first == null || last == null) return [...points];
  const tMin = first.t;
  const tMax = last.t;
  if (tMax === tMin) return [first];

  const byBucket = new Map<number, MinMaxPoint[]>();
  for (const p of sorted) {
    const bucket = Math.min(
      Math.floor(((p.t - tMin) * (buckets - 1)) / (tMax - tMin)),
      buckets - 1,
    );
    const arr = byBucket.get(bucket) ?? [];
    arr.push(p);
    byBucket.set(bucket, arr);
  }

  const out: MinMaxPoint[] = [];
  for (const pts of byBucket.values()) {
    const head = pts[0];
    if (head == null) continue;
    let min = head;
    let max = head;
    for (const p of pts) {
      if (p.total < min.total || (p.total === min.total && p.t < min.t)) min = p;
      if (p.total > max.total || (p.total === max.total && p.t < max.t)) max = p;
    }
    if (min.t === max.t && min.total === max.total) out.push(min);
    else {
      out.push(min);
      if (max.t !== min.t || max.total !== min.total) out.push(max);
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
