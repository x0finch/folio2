import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { buildAccountValueHistory, buildPortfolioHistory } from "../history";
import { deriveLiveAccountTotals } from "../live-value";
import { requireAuth } from "../require-auth";
import { db } from "./db";
import { injectManualSnapshots } from "./manual";
import { oracle } from "./oracle";

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
    // manual 不写快照(ADR 0018):当下点的 manual 净值由 creds 现造注入(过去点仍来自真实快照 totals)。
    await injectManualSnapshots(context.userId, accounts, byAccount);
    const liveTotals = await deriveLiveAccountTotals(
      accounts,
      byAccount,
      oracle.tokens,
      settings.valuationMode,
    );
    let grand = 0;
    for (const v of liveTotals.values()) grand += v;
    series[series.length - 1] = { ...series[series.length - 1], total: grand };
    return { series };
  });

// 单账户价值历史(A2 抽屉头部 chart):该账户全部快照 (takenAt, totalUsd) → 升序序列,since 裁窗口。
// listSnapshotsByAccount 内含 assertAccountOwned(越权即抛)。过去点与末点均用冻结 usd_value ——
// 账户页/抽屉头 account.totalUsd 亦为冻结最新快照总额,故曲线当下点 ≡ 头部数值,无需 live 覆写
// (deriveLiveAccountTotals 是主页 hero 现推专属,见 #81)。轻量:仅一次快照读,不做富化/估值。
export const getAccountValueHistory = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(
    z.object({ accountId: z.string().min(1), since: z.number().int().nonnegative().optional() }),
  )
  .handler(async ({ data, context }) => {
    const snapshots = await db.listSnapshotsByAccount(context.userId, data.accountId);
    return { series: buildAccountValueHistory(snapshots, data.since) };
  });
