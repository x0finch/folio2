import { getLogger } from "@logtape/logtape";
import { createServerFn } from "@tanstack/react-start";
import { displayAssetRef } from "../tokens";
import { userDisplayBalances } from "../user-balances";
import { db } from "./internal/db";
import { manualBalancesForWarm } from "./internal/manual";
import { oracle } from "./internal/oracle";
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
    // 与 enrichBalances 同门(displayAssetRef):defi 行标了 stale 就必须刷得到。
    const assets = userDisplayBalances(snapshots, manualBalances).map(displayAssetRef);
    const refreshed = await oracle.tokens.refreshStalePrices(assets);
    priceLog.info("stale prices refreshed", { refreshed });
    return { refreshed };
  });
