import { Database } from "@folio/db";
import { Oracle } from "@folio/oracle";
import { getLogger } from "@logtape/logtape";
import { Effect } from "effect";
import { refreshableTokenIds, userDisplayBalances } from "@/lib/core/token-model";
import { manualBalancesForWarm } from "@/lib/server/manual/store";

const priceLog = getLogger(["folio", "web", "prices"]);

// SWR 刷价(客户端在看到 pricesStale 后调用):对该用户最新快照的全部持仓,凡解析出 ref 且价
// stale/缺失者一次批量回源写回。服务端自算 stale 集(不信客户端入参);失败静默(下次再试)。
//
// **整个 handler 一个 effect、一次装配**(#394 T5)。以前是「两次 db 读 → 一次 manual 合成
// (它自己又读一遍 db)→ 一次 runOracle」,四趟各切一次边界;现在读快照、读账户、合 manual、
// 回源刷价共一份 context。
export const handleRefreshStalePrices = Effect.fn("refreshStalePrices")(function* () {
  const db = yield* Database;
  // 两次读互不依赖 → 并发取。
  const [snapshots, accounts] = yield* Effect.all([db.snapshots.latest(), db.accounts.list()], {
    concurrency: 2,
  });
  // 三门同源(userDisplayBalances):manual 已退出快照但其合成余额经 injectManualSnapshots 进 enrich 门 →
  // refresh 门必须同源覆盖,否则 manual 代币被标 stale 却刷不到、pricesStale 永清不掉、客户端空转刷新。
  const manualBalances = yield* manualBalancesForWarm(accounts);
  // 与 enrichBalances 的 pricesStale gate 同门(refreshableTokenIds):dust 两侧一致跳过,
  // 否则被跳过的币标了 stale 却刷不到、pricesStale 永清不掉、客户端空转(#245 / 三门同源)。
  const ids = refreshableTokenIds(userDisplayBalances(snapshots, manualBalances));
  // 元信息一并刷:**上游是 symbol/name/logo 的权威源**,行是拿连接器报的那份建起来的,
  // 而链上合约里的 symbol 可能过时(MATIC→POL)→ 同一个币在链上侧与交易所侧显示成两个名字。
  // 挂在这条路上而不是另开一个端点:同一批 id、同一个「该刷了」的时机,只是 TTL 一长一短
  // (30d / 30min),所以绝大多数调用里它一条都不刷、零请求。
  // 一个方法两半的账:同一批 id 的 store 读只发一次,价与 info 两条分支并发。
  // 各自失败不拖垮对方(内部 `Effect.either` + 记一行),`degraded` 带回来只为进日志。
  const report = yield* Effect.flatMap(Oracle, (o) => o.tokens.refreshStale(ids));
  priceLog.info("stale prices refreshed", { ...report });
  return { refreshed: report.prices };
});
