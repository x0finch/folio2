import type { UpstreamError } from "@folio/client-core";
import type { CacheStore, DbRequest } from "@folio/db";
import { DAILY_FILL_DAYS_PER_CALL, dayBucketOf } from "@folio/oracle-basic";
import { Clock, Effect, Either, Option, Schema } from "effect";
import { logDegraded } from "./tokens/swr";

// **补历史日价的那一处**(FOL-90)—— 代币的 `tokens.fillDaily` 与法币的 `fx.fillDaily` 共用。
//
// 以前历史日价在**读**的时候补:`priceSeries` / `rateSeries` 看到缺的过去日(以及永远「缺」的今天)
// 就当场回源,于是每看一次图表就是一发(法币两发)CoinGecko。现在读那一侧只读表,补的活由队列的
// `daily-prices` 消息在这里做,一条消息一份出网预算(`maxCalls`)。
//
// **只补过去日**:今天那一格读的时候取现价(代币价表 / 汇率缓存 —— 每小时的 `prices` / `fx` 活
// 在刷它们)。落一个今天的日中价进 `token_daily_prices`,明天它就成了一个「不可变的过去日」,
// 而那其实是某个钟点的价,不是那天的价。
//
// **「试过哪一段」记在 per-user 缓存里**(`daily-cover:<目标>` → `{ lo, hi }` 两个日桶,闭区间)。
// 不能只看表里缺不缺:上游对某些日子**就是没有点**(币还没上线、中间断档),只看表的话这些日子
// 永远算「缺」,每小时都要为它们白打一发。有了这段「试过」,补完之后重跑是一次缓存读、零出网。
// 区间恒连续:往后(`hi` 之后到昨天)按升序补,往前(`lo` 之前到首笔活动那天)按降序补,
// 每补完一窗就把那一端推过去 —— 预算用完 / 某一窗失败时停在哪儿,下一次就从哪儿接着补。
// 表里已经有整窗的(别的用户、或 FOL-90 之前读路径落过的)→ 直接算「试过」,不出网。
//
// 某一窗**失败** → 这个目标这一趟停在那儿、区间不推过去,下一次再试(日志里有一行)。
// 永久失败的那一窗(上游不给那么老的数据)因此每次都会再白打一发 —— 往后的那一段先补,
// 所以它挡不住「昨天」进表。

/** 一次补的结果,给调用方记账(出网预算)与决定要不要投后续消息。 */
export interface DailyFillReport {
  /** 这一趟**按最坏情形**记下的上游请求数(不含 adapter 自己的重试)。 */
  readonly calls: number;
  /** 从首笔活动那天到昨天都试过了 —— 下一趟零出网。 */
  readonly done: boolean;
  /** 某一窗回源失败,这一趟停在那儿(下一次再试)。 */
  readonly failed: boolean;
}

/** 一个要补的目标:按日桶读表 / 按窗回源 / 写表。**收已解析好的端口**,`R` 里只有 `DbRequest`。 */
export interface DailySource {
  /** 这一窗最坏打几发上游(代币 1;法币 2 —— BTC 该币 + BTC 美元两条腿)。 */
  readonly callsPerWindow: number;
  readonly read: (
    buckets: readonly number[],
  ) => Effect.Effect<Map<number, number>, never, DbRequest>;
  /** 闭区间 `[fromB, toB]` 的日桶 → 价。多给的桶由调用方丢掉。 */
  readonly fetch: (
    fromB: number,
    toB: number,
  ) => Effect.Effect<ReadonlyMap<number, number>, UpstreamError, DbRequest>;
  readonly write: (
    rows: readonly { dayBucket: number; unitPrice: number }[],
  ) => Effect.Effect<void, never, DbRequest>;
}

/** 「试过的区间」住的缓存键。一个目标一个。 */
const coverageKey = (target: string): string => `daily-cover:${target}`;

// 这个值没有「过期」一说(过去日不可变);缓存表要一个 TTL,读的时候也不看 stale。
const COVERAGE_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;

const Coverage = Schema.Struct({ lo: Schema.Number, hi: Schema.Number });
type Coverage = typeof Coverage.Type;
const decodeCoverage = Schema.decodeUnknownOption(Coverage);

interface FillWindow {
  readonly fromB: number;
  readonly toB: number;
  /** 补完之后推哪一端:`up` 推 `hi`、`down` 推 `lo`。 */
  readonly dir: "up" | "down";
}

/**
 * 纯规划:`[wantFromB, throughB]` 减去已试过的 `cover`,切成每窗 ≤ `days` 天。
 * 先往后(升序,离今天近的先补 —— 图表最常看的就是最近那一段),再往前(降序)。
 * `cover` 与想要的区间不相接(首笔活动被改到了很久之后)→ 当它不存在,从头规划。
 * 回的 `base` 是补之前的区间(空区间记成 `{ lo: throughB + 1, hi: throughB }`),每补完一窗推一端。
 */
const planFillWindows = (
  wantFromB: number,
  throughB: number,
  cover: Coverage | undefined,
  days: number = DAILY_FILL_DAYS_PER_CALL,
): { base: Coverage; windows: FillWindow[] } => {
  const usable =
    cover !== undefined &&
    cover.lo <= cover.hi + 1 &&
    cover.hi >= wantFromB - 1 &&
    cover.lo <= throughB + 1;
  const base = usable ? cover : { lo: throughB + 1, hi: throughB };
  const windows: FillWindow[] = [];
  if (wantFromB > throughB) return { base, windows };
  for (let b = base.hi + 1; b <= throughB; b += days) {
    windows.push({ fromB: b, toB: Math.min(b + days - 1, throughB), dir: "up" });
  }
  for (let e = base.lo - 1; e >= wantFromB; e -= days) {
    windows.push({ fromB: Math.max(e - days + 1, wantFromB), toB: e, dir: "down" });
  }
  return { base, windows };
};

const bucketsOf = (fromB: number, toB: number): number[] => {
  const out: number[] = [];
  for (let b = fromB; b <= toB; b++) out.push(b);
  return out;
};

/**
 * 把一个目标从 `fromMs` 那天补到昨天,至多花 `maxCalls` 发(按 `callsPerWindow` 的最坏情形记账)。
 * 永不失败:回源失败记一行、停在那一窗(`failed`)。`at` 只进日志。
 */
export const fillDaily = (
  cache: CacheStore,
  target: string,
  source: DailySource,
  fromMs: number,
  maxCalls: number,
  at: string,
): Effect.Effect<DailyFillReport, never, DbRequest> =>
  Effect.gen(function* () {
    const throughB = dayBucketOf(yield* Clock.currentTimeMillis) - 1; // 昨天
    const wantFromB = dayBucketOf(fromMs);
    if (wantFromB > throughB) return { calls: 0, done: true, failed: false };
    const key = coverageKey(target);
    const stored = Option.flatMap(yield* cache.get(key), (e) => decodeCoverage(e.value));
    const plan = planFillWindows(wantFromB, throughB, Option.getOrUndefined(stored));
    const windows = plan.windows;
    if (windows.length === 0) return { calls: 0, done: true, failed: false };

    let cover = plan.base;
    let calls = 0;
    let failed = false;
    let doneWindows = 0;
    for (const w of windows) {
      const buckets = bucketsOf(w.fromB, w.toB);
      const have = yield* source.read(buckets);
      if (have.size < buckets.length) {
        if (calls + source.callsPerWindow > maxCalls) break;
        calls += source.callsPerWindow;
        const got = yield* Effect.either(source.fetch(w.fromB, w.toB));
        if (Either.isLeft(got)) {
          yield* logDegraded(at, got.left);
          failed = true;
          break;
        }
        const rows: { dayBucket: number; unitPrice: number }[] = [];
        for (const [dayBucket, unitPrice] of got.right) {
          if (dayBucket >= w.fromB && dayBucket <= w.toB && !have.has(dayBucket)) {
            rows.push({ dayBucket, unitPrice });
          }
        }
        yield* source.write(rows);
      }
      cover = w.dir === "up" ? { lo: cover.lo, hi: w.toB } : { lo: w.fromB, hi: cover.hi };
      doneWindows++;
    }
    if (doneWindows > 0) yield* cache.put(key, cover, COVERAGE_TTL_MS);
    return { calls, done: doneWindows === windows.length, failed };
  });
