import { TokenReader } from "@folio/oracle";
import { getLogger } from "@logtape/logtape";
import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";
import { refreshableTokenIds } from "../tokens";
import { userDisplayBalances } from "../user-balances";
import { db } from "./internal/db";
import { manualBalancesForWarm } from "./internal/manual";
import { runOracle } from "./internal/oracle";
import { requireAuth } from "./internal/require-auth";

const priceLog = getLogger(["folio", "web", "prices"]);

// SWR 刷价(客户端在看到 pricesStale 后调用):对该用户最新快照的全部持仓,凡解析出 ref 且价
// stale/缺失者一次批量回源写回。服务端自算 stale 集(不信客户端入参);失败静默(下次再试)。
export const refreshStalePrices = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const [snapshots, accounts] = await Promise.all([
      db.getLatestSnapshotByUser(context.userId),
      db.listAccountsByUser(context.userId),
    ]);
    // 三门同源(userDisplayBalances):manual 已退出快照但其合成余额经 injectManualSnapshots 进 enrich 门 →
    // refresh 门必须同源覆盖,否则 manual 代币被标 stale 却刷不到、pricesStale 永清不掉、客户端空转刷新。
    const manualBalances = await manualBalancesForWarm(context.userId, accounts);
    // 与 enrichBalances 的 pricesStale gate 同门(refreshableTokenIds):dust 两侧一致跳过,
    // 否则被跳过的币标了 stale 却刷不到、pricesStale 永清不掉、客户端空转(#245 / 三门同源)。
    const ids = refreshableTokenIds(userDisplayBalances(snapshots, manualBalances));

    // 元信息一并刷:**上游是 symbol/name/logo 的权威源**,行是拿连接器报的那份建起来的,
    // 而链上合约里的 symbol 可能过时(MATIC→POL)→ 同一个币在链上侧与交易所侧显示成两个名字。
    // 挂在这条路上而不是另开一个端点:同一批 id、同一个「该刷了」的时机,只是 TTL 一长一短
    // (30d / 30min),所以绝大多数调用里它一条都不刷、零请求。
    // 一个方法两半的账:同一批 id 的 store 读只发一次,价与 info 两条分支并发。
    // 各自失败不拖垮对方(内部 `Effect.either` + 记一行),`degraded` 带回来只为进日志。
    const report = await runOracle(
      context.userId,
      Effect.flatMap(TokenReader, (tokens) => tokens.refreshStale(ids)),
    );
    priceLog.info("stale prices refreshed", { ...report });
    return { refreshed: report.prices };
  });
