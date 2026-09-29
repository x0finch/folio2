import type { CacheStore, DbRequest, TokenPriceStore, TokenStore } from "@folio/db";
import type { TokenPricePoint } from "@folio/oracle-basic";
import { dayBucketOf, MS_PER_DAY } from "@folio/oracle-basic";
import type { TokenUpstream } from "@folio/oracle-basic/ports";
import { Clock, Effect, Option } from "effect";
import { type DailyFillReport, fillDaily } from "../daily-fill";

// 历史日价(#148 / ADR 0019)。与 `./price` 的现价分开成一片,因为**判据不同**:
// 过去日不可变(落库一次,永久命中),今日桶可变。
//
// **读与补分开了(FOL-90)。** 以前 `priceSeries` 是 SWR:缺的过去日与「今天」当场回源 —— 手记账户
// 的每一次图表读都是一发 CoinGecko。现在:
//   `priceSeries` / `priceAt`  **只读**:过去日读 `token_daily_prices`,今天读价表的现价
//                              (每小时的 `prices` 活在刷它)。缺的日子就不在结果里,由调用方降级。
//   `fillDaily`                **唯一回源处**:队列的 `daily-prices` 活按预算把首笔活动那天到昨天补齐
//                              (`../daily-fill`)。
export interface TokenHistory {
  // 历史日价序列,**零网络**:过去日只给表里有的;今日桶给价表里的现价(多旧都给,没有就缺)。
  priceSeries(
    tokenId: string,
    fromMs: number,
    toMs: number,
  ): Effect.Effect<readonly TokenPricePoint[], never, DbRequest>;
  // 某时刻的历史价:atMs 所属 UTC 日桶的价;该日无数据 → `none`(调用方降级)。零网络。
  priceAt(tokenId: string, atMs: number): Effect.Effect<Option.Option<number>, never, DbRequest>;
  // 把 `fromMs` 那天到昨天的日价补进表,至多 `maxCalls` 发上游(FOL-90)。上游没认出来的币 → 无事可做。
  fillDaily(
    tokenId: string,
    fromMs: number,
    maxCalls: number,
  ): Effect.Effect<DailyFillReport, never, DbRequest>;
}

export const makeHistory = (
  store: TokenStore,
  prices: TokenPriceStore,
  cache: CacheStore,
  upstream: TokenUpstream,
): TokenHistory => {
  const priceSeries = (
    tokenId: string,
    fromMs: number,
    toMs: number,
  ): Effect.Effect<readonly TokenPricePoint[], never, DbRequest> =>
    Effect.gen(function* () {
      const info = yield* store.getById(tokenId);
      // 上游还没认出它 → 没有历史价(本源只认自己给的名字)。
      const ref = Option.flatMap(info, (i) => Option.fromNullable(i.ref));
      if (Option.isNone(ref) || fromMs > toMs) return [];

      const todayB = dayBucketOf(yield* Clock.currentTimeMillis);
      const fromB = dayBucketOf(fromMs);
      const toB = dayBucketOf(toMs);
      const daily: number[] = []; // 除今天以外的桶都读日价表(过去日;未来的桶表里本就没有)
      for (let b = fromB; b <= toB; b++) if (b !== todayB) daily.push(b);
      const withToday = fromB <= todayB && todayB <= toB;

      const cached = yield* prices.getDaily(tokenId, daily);
      const current = withToday ? (yield* prices.getByIds([tokenId])).get(tokenId) : undefined;
      const out: TokenPricePoint[] = [];
      for (let b = fromB; b <= toB; b++) {
        const price = b === todayB ? current?.unitPrice : cached.get(b);
        if (typeof price === "number") out.push({ atMs: b * MS_PER_DAY, unitPrice: price });
      }
      return out;
    });

  return {
    priceSeries,

    // 只要那一天的最后一点 —— 复用 `priceSeries`,别再开一条取数路。
    priceAt: (tokenId, atMs) =>
      Effect.map(
        Effect.suspend(() => priceSeries(tokenId, dayBucketOf(atMs) * MS_PER_DAY, atMs)),
        (series) => Option.fromNullable(series.at(-1)?.unitPrice),
      ),

    fillDaily: (tokenId, fromMs, maxCalls) =>
      Effect.gen(function* () {
        const info = yield* store.getById(tokenId);
        const ref = Option.flatMap(info, (i) => Option.fromNullable(i.ref));
        if (Option.isNone(ref)) return { calls: 0, done: true, failed: false };
        return yield* fillDaily(
          cache,
          tokenId,
          {
            callsPerWindow: 1,
            read: (buckets) => prices.getDaily(tokenId, buckets),
            fetch: (fromB, toB) =>
              Effect.map(
                upstream.fetchPriceSeries(
                  ref.value,
                  fromB * MS_PER_DAY,
                  (toB + 1) * MS_PER_DAY - 1,
                ),
                (points) => {
                  const byDay = new Map<number, number>();
                  // 升序 → 当日最后一点胜出
                  for (const pt of points) byDay.set(dayBucketOf(pt.atMs), pt.unitPrice);
                  return byDay;
                },
              ),
            write: (rows) => prices.putDaily(tokenId, rows),
          },
          fromMs,
          maxCalls,
          "tokens.fillDaily",
        );
      }),
  };
};
