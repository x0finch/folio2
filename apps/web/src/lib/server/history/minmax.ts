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
  // **端点强制保留**(与 packages/db 的 history-minmax.ts 同款):各 manual 账户各自降采样后要和
  // 别账户的行拼起来逐 takenAt 求和,某账户若从窗口起点起缺第一个点,别人在更早时刻求和时它会被
  // 整个漏掉,画出假凹口。锚住首末点让每条序列覆盖到窗口两端,合并处处不缺人。
  if (!out.some((p) => p.t === first.t)) out.push(first);
  if (!out.some((p) => p.t === last.t)) out.push(last);
  return out.sort((a, b) => a.t - b.t);
}
