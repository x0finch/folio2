import { AccountStore, PortfolioStore, SettingsStore, SnapshotStore } from "@folio/db";
import { Effect } from "effect";
import { accountIdsInView, accountsInView } from "@/lib/core/accounts-in-view";
import { isManual } from "@/lib/core/manual";
import { injectManualSnapshots, loadManualHistoryRows } from "@/lib/server/manual/store";
import { runRequest } from "@/lib/server/oracle";
import type { AuthContext } from "@/lib/server/session/auth-session";
import { buildPortfolioHistory } from "./history";
import { deriveLiveAccountTotals } from "./live-value";
import { resolveScope } from "./scope";

// 组合净值历史:全部快照总额 → 阶梯式重建为时间序列(纯函数,可序列化输出)。
// 「当下点」(最新点)不用快照冻结总额,而是与主页同款**现推实时总价**(deriveLiveAccountTotals,
// self-first 下盯市行取实时源价)→ 主页总价 ≡ 曲线当下点(#81);更早点仍用冻结 usd_value。
//
// **整条链一个 effect,一次装配**(#394 T6):以前这里是 1 次 resolveScope + 5 次门面读 +
// 1 次 manual 历史(内部逐账户又各装一次)+ 1 次注入 + 1 次实时总价 —— 一个请求切了近十次边界。
export function handleGetPortfolioHistory({
  data,
  context,
}: {
  data: { portfolioId?: string };
  context: AuthContext;
}) {
  return runRequest(
    context.userId,
    Effect.gen(function* () {
      const { selectedId, defaultId } = yield* resolveScope(data.portfolioId);
      const [rows, allAccounts, snapshots, settings, memberships] = yield* Effect.all(
        [
          Effect.flatMap(SnapshotStore, (s) => s.listTotals()),
          Effect.flatMap(AccountStore, (s) => s.list()),
          Effect.flatMap(SnapshotStore, (s) => s.latest()),
          Effect.flatMap(SettingsStore, (s) => s.get()),
          Effect.flatMap(PortfolioStore, (s) => s.listMemberships()),
        ],
        { concurrency: 5 },
      );
      // 曲线追溯性地只算选中 Portfolio 的当前成员(ADR 0033):
      //  · memberSet = 归属选中的账户(**含已归档**)→ 过去点按它 scope,保留归档成员的历史贡献;
      //  · accounts  = 其中未归档的 → 曲线当下点(live 覆写)只算活跃成员。
      // 把账户移进/移出 Portfolio,这条曲线整条重算(直觉:这钱在这个视图里从来算/不算)。
      // 自定义 Tab(ADR 0034 UI 微调):曲线**不按 pin 收窄** —— pin 只过滤该 Tab 的列表内容,
      // hero 总额/曲线保持选中 Portfolio 口径(用户明确:自定义 Tab 不改 hero)。故历史入参不带 pin。
      const memberSet = accountIdsInView(
        allAccounts.map((a) => a.id),
        memberships,
        selectedId,
        defaultId,
      );
      const memberAccounts = allAccounts.filter((a) => memberSet.has(a.id));
      const accounts = accountsInView(allAccounts, memberships, selectedId, defaultId);

      // manual 历史改由账本 compute-on-read 供货(ADR 0018):防御式排除任何遗留 manual snapshot 行(正常为空),
      // 再拼上账本现算的 manual (takenAt, totalUsd) 行 → 同喂 buildPortfolioHistory,不双算、无需特殊合并。
      const now = Date.now();
      const manualIds = new Set(
        memberAccounts.filter((a) => isManual(a.connectorId)).map((a) => a.id),
      );
      const snapRows = rows.filter(
        (r) => !manualIds.has(r.accountId) && memberSet.has(r.accountId),
      );
      // manual 走日网格 compute-on-read(ADR 0019),末点 τ=now → 与下方 live 覆写同刻对齐。
      const manualRows = yield* loadManualHistoryRows(memberAccounts, now);
      // 归档成员的历史贡献保留到归档那一刻为止(ADR 0039)—— 不传这张表的话,它冻住的值会
      // 一路保持到今天,而下面的当下点只算活跃账户,曲线就会「一路平着、到头凭空掉一截」。
      const archivedAt = new Map(
        memberAccounts.flatMap((a) =>
          a.archivedAt == null ? [] : [[a.id, a.archivedAt] as const],
        ),
      );
      const series = buildPortfolioHistory([...snapRows, ...manualRows], archivedAt);
      if (series.length === 0) return { series };

      // 当下点 = 与主页同源同算的实时总价(活跃账户,与 getPortfolioOverview 一致的账户集 + 同一 mode)。
      const byAccount = new Map(snapshots.map((s) => [s.snapshot.accountId, s]));
      // manual 不写快照(ADR 0018):当下点的 manual 净值由 creds 现造注入(过去点仍来自真实快照 totals)。
      yield* injectManualSnapshots(accounts, byAccount);
      const liveTotals = yield* deriveLiveAccountTotals(
        accounts,
        byAccount,
        settings.valuationMode,
      );
      let grand = 0;
      for (const v of liveTotals.values()) grand += v;
      series[series.length - 1] = { ...series[series.length - 1], total: grand };
      return { series };
    }),
  );
}
