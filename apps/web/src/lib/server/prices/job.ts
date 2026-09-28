import { Database, type DbRequest, type NotFound, type SnapshotWithBalances } from "@folio/db";
import { Oracle, type RefreshStaleReport } from "@folio/oracle";
import { getLogger } from "@logtape/logtape";
import { Effect } from "effect";
import { refreshableTokenIds, userDisplayBalances } from "@/lib/core/token-model";
import { PRICES_IDS_PER_MESSAGE } from "@/lib/server/jobs/constants";
import type { PricesJob } from "@/lib/server/jobs/message";
import { type Enqueued, enqueue } from "@/lib/server/jobs/queue";
import { manualBalancesForWarm } from "@/lib/server/manual/store";
import { forUser } from "@/lib/server/runtime";

// **持仓价的回源处**(FOL-87)。以前有三条路会为持仓价出网:同步重估里逐币的 `priceOf`、
// 同步后的预热、以及首页 / 账户页挂载时自动调的 `refreshStalePrices` server fn(一个读页面顺手
// 打 CoinGecko 再写库)。现在:cron 每小时给每个用户投一条 `prices`,consumer 在这里按 100 个一批
// 回源、写回价表;重估与展示一律只读表。
//
// 手动同步(`/api/sync`、`syncAccount`)收尾的 `warmTokens` 仍在 HTTP 调用里刷一遍价(同样经
// `refreshPricesOf`)。FOL-89 把那两条改成投队列时,它们改投一条 `prices` 即可。

const log = getLogger(["folio", "jobs", "prices"]);

/**
 * 这个用户此刻「在看的币」:最新快照 + 手记合成余额,过同一道 dust 门(`refreshableTokenIds`)。
 * **三门同源**:展示侧标 stale 的集合必须是这里的子集,否则标了 stale 的币永远刷不到。
 * 快照由调用方给 —— 预热那条路手上已经有一份,不再读第二遍。
 */
export const heldTokenIdsOf = (
  snapshots: SnapshotWithBalances[],
): Effect.Effect<string[], NotFound, Database | DbRequest> =>
  Effect.gen(function* () {
    const accounts = yield* (yield* Database).accounts.list();
    // manual 已退出快照(ADR 0018)→ 从手记的 creds 现造合成余额,否则纯手记用户的币永远暖不到价。
    const manualBalances = yield* manualBalancesForWarm(accounts);
    return refreshableTokenIds(userDisplayBalances(snapshots, manualBalances));
  });

/**
 * 一批 id 里价 / 元信息 stale 或缺失的,回源写回(`refreshStale`:两次 store 读 + 每条端点按 100 个
 * 一批)。**调用方负责把批控制在一条消息的预算内**(`PRICES_IDS_PER_MESSAGE`)。
 * 暖不上要喊一声(#375):连着几天都这样该有人发现。
 */
export const refreshPricesOf = (
  ids: readonly string[],
): Effect.Effect<RefreshStaleReport, never, Oracle | DbRequest> =>
  Effect.tap(
    Effect.flatMap(Oracle, (o) => o.tokens.refreshStale(ids)),
    (report) =>
      Effect.sync(() => {
        const meta = { ids: ids.length, ...report };
        if (report.degraded) log.warn("held prices partially refreshed", meta);
        else log.debug("held prices refreshed", meta);
      }),
  );

/** 按预算切块。空输入 → 一块空的(规划那条照样「刷」一遍 —— 空批不出网,只是少一个分支)。 */
const chunkTokenIds = (
  ids: readonly string[],
  size: number = PRICES_IDS_PER_MESSAGE,
): string[][] => {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out.length === 0 ? [[]] : out;
};

/**
 * `prices` 的 consumer。规划那条(没带 `tokenIds`)自己刷第一块、其余每块投一条;带块的那条只刷它。
 *
 * **先刷、后投**:刷是幂等的(刚刷过的都新鲜了,再跑一遍零出网),投不是。反过来的话,刷那一步
 * 以 defect 失败、队列重投时会把后续块再投一遍。现在的顺序下,投失败 → 重投 → 第一块零出网、
 * 后续块照投。
 */
export const runPricesJob = (job: PricesJob): Effect.Effect<void, Error> =>
  forUser(
    job.userId,
    Effect.gen(function* () {
      if (job.tokenIds) {
        yield* refreshPricesOf(job.tokenIds);
        return;
      }
      const snapshots = yield* (yield* Database).snapshots.latest();
      const [head = [], ...rest] = chunkTokenIds(yield* heldTokenIdsOf(snapshots));
      yield* refreshPricesOf(head);
      if (rest.length === 0) return;
      log.info("held prices split across messages", { messages: rest.length + 1 });
      yield* enqueue(
        rest.map(
          (tokenIds): Enqueued => ({ job: { kind: "prices", userId: job.userId, tokenIds } }),
        ),
      );
    }),
  );
