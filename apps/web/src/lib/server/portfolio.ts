import { createServerFn } from "@tanstack/react-start";
import { buildPortfolioHistory } from "../history";
import { deriveLiveAccountTotals } from "../live-value";
import { isManual } from "../manual-connector";
import { buildOverview } from "../overview-model";
import { connectorPlatformMeta } from "./internal/connector-platform";
import { db } from "./internal/db";
import { injectManualSnapshots, loadManualHistoryRows, manualFiatRefs } from "./internal/manual";
import { oracleFor } from "./internal/oracle";
import { requireAuth } from "./internal/require-auth";
import { enrichBalances } from "./internal/token-enrich";

// 总览(P2:按代币聚合)。装配逻辑在纯模块 ../overview-model(buildOverview);此处只做
// 鉴权 + 加载(accounts / 最新快照)+ 注入依赖(tokens / platforms)+ 调用。
export const getPortfolioOverview = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const [allAccounts, snapshots, settings] = await Promise.all([
      db.listAccountsByUser(context.userId),
      db.getLatestSnapshotByUser(context.userId),
      db.getUserSettings(context.userId),
    ]);
    const accounts = allAccounts.filter((a) => a.archivedAt == null);
    const byAccount = new Map(snapshots.map((s) => [s.snapshot.accountId, s]));
    // manual 不写快照(ADR 0018):为 manual 账户注入从 creds.tokens 现造的合成当下项。
    await injectManualSnapshots(context.userId, accounts, byAccount);
    // 法币身份(#271):按 token_id 取各法币持仓的 fiat 命名者 ref → overview 经 fiatCodeOf 算 isFiat
    //(计入净值本就由 spot 聚合负责,这里只补「哪些行是法币」用于稳定占比)。
    const fiatRefs = await manualFiatRefs(context.userId, accounts);
    return buildOverview(accounts, byAccount, {
      tokens: oracleFor(context.userId).tokens,
      platforms: oracleFor(context.userId).platforms,
      connectorMeta: connectorPlatformMeta,
      mode: settings.valuationMode,
      fiatRefs,
    });
  });

// 按账户视图(账户页浏览器 + 详情侧栏用):每个活跃账户 + 其最新快照的富化持仓。
// 与 getPortfolioOverview(按代币聚合)分开 —— 账户页是"按账户"的 home,需要每账户明细。
export const listAccountHoldings = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const [allAccounts, snapshots] = await Promise.all([
      db.listAccountsByUser(context.userId),
      db.getLatestSnapshotByUser(context.userId),
    ]);
    const accounts = allAccounts.filter((a) => a.archivedAt == null);
    const byAccount = new Map(snapshots.map((s) => [s.snapshot.accountId, s]));
    // manual 不写快照(ADR 0018):注入合成当下项,manual 账户行的市值/持仓由 creds 现造。
    await injectManualSnapshots(context.userId, accounts, byAccount);
    const tokens = oracleFor(context.userId).tokens;
    const rows = await Promise.all(
      accounts.map(async (account) => {
        const latest = byAccount.get(account.id);
        const enriched = await enrichBalances(tokens, latest?.balances ?? []);
        return {
          account: { id: account.id, label: account.label },
          totalUsd: latest?.snapshot.totalUsd ?? 0,
          takenAt: latest?.snapshot.takenAt ?? null,
          // note 重设计(两级):① balance 级单个 note 随各 balance 透传(db 已把 snapshot_balances.note
          // safeParse 成 Note),现货行副行渲染 <NoteBadge>;② account 级 note(Note[],整钱包,BTC 未确认/
          // 收款/派生分布)是每账户一份,db 已 safeParse 成 Note[],这里随 row.note 带出 → 持仓区手风琴。
          note: latest?.note,
          balances: enriched.rows,
          pricesStale: enriched.pricesStale,
        };
      }),
    );
    return { rows, pricesStale: rows.some((r) => r.pricesStale) };
  });

// 组合净值历史:全部快照总额 → 阶梯式重建为时间序列(纯函数,可序列化输出)。
// 「当下点」(最新点)不用快照冻结总额,而是与主页同款**现推实时总价**(deriveLiveAccountTotals,
// self-first 下盯市行取实时源价)→ 主页总价 ≡ 曲线当下点(#81);更早点仍用冻结 usd_value。
export const getPortfolioHistory = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const [rows, allAccounts, snapshots, settings] = await Promise.all([
      db.listSnapshotTotalsByUser(context.userId),
      db.listAccountsByUser(context.userId),
      db.getLatestSnapshotByUser(context.userId),
      db.getUserSettings(context.userId),
    ]);
    const accounts = allAccounts.filter((a) => a.archivedAt == null);

    // manual 历史改由账本 compute-on-read 供货(ADR 0018):防御式排除任何遗留 manual snapshot 行(正常为空),
    // 再拼上账本现算的 manual (takenAt, totalUsd) 行 → 同喂 buildPortfolioHistory,不双算、无需特殊合并。
    // 用 allAccounts(含归档):历史保留归档账户过去贡献(与 synced 快照一致),末点仍由下方 live 覆写(仅活跃)剔出。
    const now = Date.now();
    const manualIds = new Set(allAccounts.filter((a) => isManual(a.connectorId)).map((a) => a.id));
    const snapRows = rows.filter((r) => !manualIds.has(r.accountId));
    // manual 走日网格 compute-on-read(ADR 0019),末点 τ=now → 与下方 live 覆写同刻对齐。
    const manualRows = await loadManualHistoryRows(context.userId, allAccounts, now);
    const series = buildPortfolioHistory([...snapRows, ...manualRows]);
    if (series.length === 0) return { series };

    // 当下点 = 与主页同源同算的实时总价(活跃账户,与 getPortfolioOverview 一致的账户集 + 同一 mode)。
    const byAccount = new Map(snapshots.map((s) => [s.snapshot.accountId, s]));
    // manual 不写快照(ADR 0018):当下点的 manual 净值由 creds 现造注入(过去点仍来自真实快照 totals)。
    await injectManualSnapshots(context.userId, accounts, byAccount);
    const liveTotals = await deriveLiveAccountTotals(
      accounts,
      byAccount,
      oracleFor(context.userId).tokens,
      settings.valuationMode,
    );
    let grand = 0;
    for (const v of liveTotals.values()) grand += v;
    series[series.length - 1] = { ...series[series.length - 1], total: grand };
    return { series };
  });
