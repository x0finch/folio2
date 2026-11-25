import type { CacheStore, DbRequest } from "@folio/db";
import { DAILY_FILL_DAYS_PER_CALL, dayBucketOf } from "@folio/oracle-basic";
import type { UpstreamError } from "@folio/upstream-basic";
import { Clock, Effect, Option, Result, Schema } from "effect";
import { logDegraded } from "./tokens/swr";

// Backfills historical daily prices; shared by token `fillDaily` and fiat `fx.fillDaily`. One queue message gets one egress budget (`maxCalls`).
// Only past days are filled: today is read from the live price caches, and persisting an intraday price
// into `token_daily_prices` would freeze it as an "immutable past day".
// The attempted range is stored in the per-user cache (`daily-cover:<target>` as `{ lo, hi }` day buckets, closed interval),
// because upstream may have no point for some days and checking the table alone would refetch them hourly. The range
// stays contiguous: forward (after `hi` to yesterday) ascending, backward (before `lo` to first activity) descending,
// advancing that end after each window, so a spent budget or failed window resumes where it stopped.
// Windows already fully in the table (other users) count as attempted without egress.
// Concurrent messages for one target are possible (queue `max_concurrency` > 1, at-least-once redelivery); the final write
// is a union (`mergeCoverage`) of the freshly re-read stored range and this run's, so a slower writer cannot shrink it.
// The remaining read-write gap only costs a few re-planned windows. A failed window stops this run for that target and
// does not advance the range; a permanently failing window is retried each run, but the forward part is filled first so it never blocks yesterday.

/** Outcome of one fill, for budget accounting and deciding on follow-up messages. */
export interface DailyFillReport {
  /** Upstream requests spent this run, counted worst case (excludes adapter retries). */
  readonly calls: number;
  /** Everything from first activity to yesterday was attempted; next run needs no egress. */
  readonly done: boolean;
  /** A window failed upstream; this run stopped there. */
  readonly failed: boolean;
}

/** One fill target: reads the table by day bucket, fetches by window, writes. Takes resolved ports, so `R` is only `DbRequest`. */
export interface DailySource {
  /** Worst-case upstream calls per window (token 1; fiat 2: BTC in that currency + BTC in USD). */
  readonly callsPerWindow: number;
  readonly read: (
    buckets: readonly number[],
  ) => Effect.Effect<Map<number, number>, never, DbRequest>;
  /** Day buckets in closed `[fromB, toB]` to price; extras are dropped by the caller. */
  readonly fetch: (
    fromB: number,
    toB: number,
  ) => Effect.Effect<ReadonlyMap<number, number>, UpstreamError, DbRequest>;
  readonly write: (
    rows: readonly { dayBucket: number; unitPrice: number }[],
  ) => Effect.Effect<void, never, DbRequest>;
}

/** Cache key of the attempted range, one per target. */
const coverageKey = (target: string): string => `daily-cover:${target}`;

// Never expires (past days are immutable); the cache table needs a TTL and reads ignore stale.
const COVERAGE_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;

const Coverage = Schema.Struct({ lo: Schema.Number, hi: Schema.Number });
type Coverage = typeof Coverage.Type;
const decodeCoverage = Schema.decodeUnknownOption(Coverage);

interface FillWindow {
  readonly fromB: number;
  readonly toB: number;
  /** Which end to advance after filling: `up` moves `hi`, `down` moves `lo`. */
  readonly dir: "up" | "down";
}

/**
 * Pure plan: `[wantFromB, throughB]` minus the attempted `cover`, cut into windows of <= `days`.
 * Forward ascending first (recent days are viewed most), then backward descending. A `cover` not adjacent to
 * the wanted range is ignored. `base` is the range before filling (empty is `{ lo: throughB + 1, hi: throughB }`).
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

/**
 * Union of two attempted ranges: overlapping or adjacent merge; disjoint takes `mine`. Empty ranges (`lo > hi`) do not merge.
 */
const mergeCoverage = (mine: Coverage, other: Coverage | undefined): Coverage => {
  if (other === undefined || other.lo > other.hi) return mine;
  if (mine.lo > mine.hi) return other;
  const touches = other.lo <= mine.hi + 1 && mine.lo <= other.hi + 1;
  return touches ? { lo: Math.min(mine.lo, other.lo), hi: Math.max(mine.hi, other.hi) } : mine;
};

const bucketsOf = (fromB: number, toB: number): number[] => {
  const out: number[] = [];
  for (let b = fromB; b <= toB; b++) out.push(b);
  return out;
};

/**
 * Fills one target from `fromMs` to yesterday, spending at most `maxCalls` (worst case per `callsPerWindow`).
 * Never fails: a failed fetch is logged and stops at that window (`failed`). `at` only goes to logs.
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
    const throughB = dayBucketOf(yield* Clock.currentTimeMillis) - 1; // yesterday
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
        const got = yield* Effect.result(source.fetch(w.fromB, w.toB));
        if (Result.isFailure(got)) {
          yield* logDegraded(at, got.failure);
          failed = true;
          break;
        }
        const rows: { dayBucket: number; unitPrice: number }[] = [];
        for (const [dayBucket, unitPrice] of got.success) {
          if (dayBucket >= w.fromB && dayBucket <= w.toB && !have.has(dayBucket)) {
            rows.push({ dayBucket, unitPrice });
          }
        }
        yield* source.write(rows);
      }
      cover = w.dir === "up" ? { lo: cover.lo, hi: w.toB } : { lo: w.fromB, hi: cover.hi };
      doneWindows++;
    }
    if (doneWindows > 0) {
      // Union write-back: a concurrent message may have advanced further (see file header).
      const latest = Option.flatMap(yield* cache.get(key), (e) => decodeCoverage(e.value));
      const merged = mergeCoverage(cover, Option.getOrUndefined(latest));
      yield* cache.put(key, merged, COVERAGE_TTL_MS);
    }
    return { calls, done: doneWindows === windows.length, failed };
  });
