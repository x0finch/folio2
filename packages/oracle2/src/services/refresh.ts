// SWR 编排 —— 「读本地 → 判 stale → 回源 → 写回」**只在这一个文件里成立**(ADR 0023)。
//
// 此前这套逻辑内联在 `priceOf` / `priceSeries` / `topTokens` 各一份:TTL 与 stale 语义有三处,
// 改一处忘两处;而且领域函数的单测必须连着缓存一起测。抽出来之后各能力只剩意图,SWR 只测一次。
//
// 「过期不删、读出带 stale」是全层的口径:价过期了仍然给旧值(展示先有数),同时标记可刷新。

export interface SwrOpts<T> {
  // 本地读。undefined = 没有;`stale` = 有但该刷了。
  read(): Promise<{ value: T; stale: boolean } | undefined>;
  // 回源。undefined = 上游也没有(限流 / 未收录 / 网络)。
  fetch(): Promise<T | undefined>;
  // 写回。只在 fetch 拿到东西时调。
  write(value: T): Promise<void>;
}

/**
 * 新鲜 → 直接回,不碰上游。stale / miss → 回源 → 写回 → 回新值。
 * 上游没有 → **把旧值原样给出去**(有旧值就用旧的,没有就 undefined)—— 绝不因为刷不到而丢数据。
 * 上游抛错也算「没有」:曲线与总额不该因为一次限流就崩(调用方降级,不向上抛)。
 */
export async function swr<T>(opts: SwrOpts<T>): Promise<T | undefined> {
  const hit = await opts.read();
  if (hit && !hit.stale) return hit.value;

  let fetched: T | undefined;
  try {
    fetched = await opts.fetch();
  } catch {
    // 限流 / 网络 / 上游无此数据 → 降级到本地(见下),不抛。
  }
  if (fetched === undefined) return hit?.value;

  await opts.write(fetched);
  return fetched;
}
