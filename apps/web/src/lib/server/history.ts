import { createServerFn } from "@tanstack/react-start";
import { buildPortfolioHistory } from "../history";
import { deriveLiveAccountTotals } from "../live-value";
import { requireAuth } from "../require-auth";
import { db } from "./db";
import { oracleFor } from "./oracle";

// 组合净值历史:全部快照总额 → 阶梯式重建为时间序列(纯函数,可序列化输出)。
// 「当下点」(最新点)不用快照冻结总额,而是与主页同款**现推实时总价**(deriveLiveAccountTotals,
// self-first 下盯市行取实时源价)→ 主页总价 ≡ 曲线当下点(#81);更早点仍用冻结 usd_value。
// mode 缺省 self-first(= 旧行为);per-user 设置接入见 P3-3。
export const getPortfolioHistory = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const [rows, allAccounts, snapshots, settings] = await Promise.all([
      db.listSnapshotTotalsByUser(context.userId),
      db.listAccountsByUser(context.userId),
      db.getLatestSnapshotByUser(context.userId),
      db.getUserSettings(context.userId),
    ]);
    const series = buildPortfolioHistory(rows);
    if (series.length === 0) return { series };

    // 当下点 = 与主页同源同算的实时总价(活跃账户,与 getMyOverview 一致的账户集 + 同一 mode)。
    const accounts = allAccounts.filter((a) => a.archivedAt == null);
    const byAccount = new Map(snapshots.map((s) => [s.snapshot.accountId, s]));
    const liveTotals = await deriveLiveAccountTotals(
      accounts,
      byAccount,
      oracleFor(settings.activeVendor).tokens,
      settings.valuationMode,
    );
    let grand = 0;
    for (const v of liveTotals.values()) grand += v;
    series[series.length - 1] = { ...series[series.length - 1], total: grand };
    return { series };
  });
