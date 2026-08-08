import type { TokenPricePoint } from "@folio/oracle-basic";
import { dayBucketOf, MS_PER_DAY } from "@folio/oracle-basic";
import type { TokenPriceStore, TokenStore, TokenUpstream } from "@folio/oracle-basic/ports";
import { Clock, Effect, Option } from "effect";
import { degradeTo } from "./swr";

// 历史日价(#148 / ADR 0019)。与 `./price` 的现价分开成一片,因为**判据不同**:
// 过去日不可变(落库一次,永久命中),今日桶可变(恒现取、绝不落库)。同一段代码里两种
// 生命周期,所以持久化也是两处:现价在价 store 的当前那几列,历史在 `token_daily_prices`。
//
// **上游挂了退回仅缓存**,不抛:曲线少一段远好过整条崩掉(本层的降级口径)。
export interface TokenHistory {
  // 历史日价序列:命中缓存的过去日直接用,缺的一次回源补齐并永久落缓存;
  // 今日桶恒现取(可变,不缓存)。上游失败 → 退回仅缓存(曲线不因缺价崩)。
  priceSeries(
    tokenId: string,
    fromMs: number,
    toMs: number,
  ): Effect.Effect<readonly TokenPricePoint[]>;
  // 某时刻的历史价:atMs 所属 UTC 日桶的价;该日无数据 → `none`(调用方降级)。
  priceAt(tokenId: string, atMs: number): Effect.Effect<Option.Option<number>>;
}

export const makeHistory = (
  store: TokenStore,
  prices: TokenPriceStore,
  upstream: TokenUpstream,
): TokenHistory => {
  const priceSeries = (
    tokenId: string,
    fromMs: number,
    toMs: number,
  ): Effect.Effect<readonly TokenPricePoint[]> =>
    Effect.gen(function* () {
      const info = yield* store.getById(tokenId);
      // 上游还没认出它 → 取不到历史价(本源只认自己给的名字)。
      const ref = Option.flatMap(info, (i) => Option.fromNullable(i.ref));
      if (Option.isNone(ref) || fromMs > toMs) return [];

      const fromB = dayBucketOf(fromMs);
      const toB = dayBucketOf(toMs);
      const todayB = dayBucketOf(yield* Clock.currentTimeMillis);
      const buckets: number[] = [];
      for (let b = fromB; b <= toB; b++) buckets.push(b);

      const cached = yield* prices.getDaily(tokenId, buckets);
      const missingPast = buckets.filter((b) => b < todayB && !cached.has(b));
      const needsToday = toB >= todayB; // 今日桶恒现取(可变,不缓存)

      const fetched = new Map<number, number>();
      if (missingPast.length > 0 || needsToday) {
        const raw = yield* upstream
          .fetchPriceSeries(ref.value, fromMs, toMs)
          .pipe(degradeTo("tokens.priceSeries", [] as readonly TokenPricePoint[]));
        for (const pt of raw) fetched.set(dayBucketOf(pt.atMs), pt.unitPrice); // 升序 → 当日最后一点胜出

        const toPersist = [...fetched.entries()]
          .filter(([b]) => b < todayB && !cached.has(b)) // 只落不可变的过去日
          .map(([dayBucket, unitPrice]) => ({ dayBucket, unitPrice }));
        if (toPersist.length > 0) yield* prices.putDaily(tokenId, toPersist);
      }

      const out: TokenPricePoint[] = [];
      for (const b of buckets) {
        const price = cached.get(b) ?? fetched.get(b);
        if (typeof price === "number") out.push({ atMs: b * MS_PER_DAY, unitPrice: price });
      }
      return out;
    });

  return {
    priceSeries,

    // 只要那一天的最后一点 —— 复用 `priceSeries`(连同它的缓存与降级),别再开一条取数路。
    priceAt: (tokenId, atMs) =>
      Effect.map(
        Effect.suspend(() => priceSeries(tokenId, dayBucketOf(atMs) * MS_PER_DAY, atMs)),
        (series) => Option.fromNullable(series.at(-1)?.unitPrice),
      ),
  };
};
