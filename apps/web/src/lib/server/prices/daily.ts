import { Database } from "@folio/db";
import { Oracle } from "@folio/oracle";
import { getLogger } from "@logtape/logtape";
import { Cause, Effect } from "effect";
import {
  DAILY_PRICES_CALLS_PER_MESSAGE,
  DAILY_PRICES_IDS_PER_MESSAGE,
} from "@/lib/server/jobs/constants";
import type { DailyPricesJob } from "@/lib/server/jobs/message";
import { type Enqueued, enqueue } from "@/lib/server/jobs/queue";
import { manualAccountTokenIds, manualDailyPriceTargets } from "@/lib/server/manual/store";
import { forUser, type UserServices } from "@/lib/server/runtime";

// **手记历史曲线的日价回源处**(FOL-90)。
//
// 手记账户不写快照(ADR 0018),它的曲线由账本 × 每日价现算。以前那份每日价在**读**的时候补 ——
// `getPortfolioHistory` / `getAccountHistory` / 带 `after` 的 `getSnapshots` 每一次都为「今天」
// (永远算没缓存)打一发 CoinGecko,法币两发,缺的过去日还要再补。现在读那一侧只读表
// (`manual/store` 的 `buildHistoricalPriceAt`),补的活在这里:
//
//   · 每小时 cron 给每个用户投一条不带 id 的(`jobs/schedule` 的 `hourlyUserJobs`)。补齐之后它是
//     几次缓存读、零出网 —— 过了零点那一小时里补一窗「昨天」,每币一发。
//   · 手记写完(加活动 / 改活动 / 建手记账户)之后投一条**带这个账户的币**的(`refillDailyPrices`),
//     新币的曲线不必等到下一个整点。
//
// 一条消息的预算是 `DAILY_PRICES_CALLS_PER_MESSAGE` 发区间请求。补的顺序是目标逐个来、每个目标
// 先补离今天近的那段;预算用完还有没补完的 → 投**一条**带剩余 id 的后续消息接着补(串行接力,
// 不并发,所以同一个币「补过哪一段」的区间不会被两条消息同时推)。一条消息一发都没花出去
// (全都失败)就不再往下投,等下一个整点 —— 接力链不会原地打转。

const log = getLogger(["folio", "jobs", "daily-prices"]);

const chunked = (ids: readonly string[]): string[][] => {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += DAILY_PRICES_IDS_PER_MESSAGE) {
    out.push(ids.slice(i, i + DAILY_PRICES_IDS_PER_MESSAGE));
  }
  return out;
};

const jobsFor = (userId: string, tokenIds: readonly string[]): Enqueued[] =>
  chunked(tokenIds).map((ids) => ({ job: { kind: "daily-prices", userId, tokenIds: ids } }));

/** `daily-prices` 的 consumer。 */
export const runDailyPricesJob = (job: DailyPricesJob): Effect.Effect<void, Error> =>
  forUser(
    job.userId,
    Effect.gen(function* () {
      const accounts = yield* (yield* Database).accounts.list();
      const all = yield* manualDailyPriceTargets(accounts);
      const only = job.tokenIds ? new Set(job.tokenIds) : undefined;
      const targets = only ? all.filter((t) => only.has(t.tokenId)) : all;
      if (targets.length === 0) return;

      const { tokens, fx } = yield* Oracle;
      let budget = DAILY_PRICES_CALLS_PER_MESSAGE;
      let failed = 0;
      const unfinished: string[] = [];
      for (const t of targets) {
        if (budget <= 0) {
          unfinished.push(t.tokenId);
          continue;
        }
        const report = t.fiatCode
          ? yield* fx.fillDaily(t.fiatCode, t.fromMs, budget)
          : yield* tokens.fillDaily(t.tokenId, t.fromMs, budget);
        budget -= report.calls;
        if (report.failed) failed++;
        else if (!report.done) unfinished.push(t.tokenId);
      }

      const spent = DAILY_PRICES_CALLS_PER_MESSAGE - budget;
      const meta = { targets: targets.length, calls: spent, failed, unfinished: unfinished.length };
      if (spent > 0 || failed > 0) log.info("daily prices filled", meta);
      // 一发都没花出去还剩活 → 那只可能是预算连一窗都不够(不会发生),别投一条同样的消息原地打转。
      if (unfinished.length === 0 || spent === 0) return;
      yield* enqueue(jobsFor(job.userId, unfinished));
    }),
  );

/**
 * 手记写完之后,给这个账户的币投一条定向的 `daily-prices`。**尽力而为**:投递失败只记一行,
 * 不让已经落库的写失败(下一个整点的 cron 照样会补)。
 *
 * userId 是显式参数(同 `sync/run` 的 `handleSyncAccount`):投的消息要带它,而 `runEffect`
 * 刻意不把 userId 交给 handler。
 */
export const refillDailyPrices = (
  userId: string,
  accountId: string,
): Effect.Effect<void, never, UserServices> =>
  Effect.gen(function* () {
    const ids = yield* manualAccountTokenIds(accountId);
    yield* enqueue(jobsFor(userId, ids));
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.sync(() =>
        log.warn("daily prices refill not queued", { accountId, error: Cause.pretty(cause) }),
      ),
    ),
  );
