import { AccountStore, SnapshotStore } from "@folio/db";
import { Effect } from "effect";
import { MANUAL_CONNECTOR_ID } from "../../core/manual";
import { buildAccountValueHistory } from "../portfolio/history";
import { loadManualAccountLiveTotal, loadManualAccountSeries } from "../manual/store";

// 单账户价值历史(抽屉头部那条小曲线)。
//
// 两条读路径:非 manual 走快照;manual 不写快照(ADR 0018)→ 走账本 compute-on-read 的日网格
// (ADR 0019),过去点由账本折叠 + oracle 历史价,**末点补一个「当下」实时盯市点**,与抽屉头
// `account.totalUsd` 同源。
//
// **归档账户的「当下」是封存那一刻**(ADR 0039)。manual 那条路本来会一路算到今天,而抽屉头显示的
// 是封存值 —— 不截断的话一个抽屉里两个说法(数字停着、曲线还在长)。归档时:
//   · 网格末点 τ = archivedAt,不是 `Date.now()`
//   · 不补实时盯市末点 —— 那正是「还在动」的那一笔
// 非 manual 不需要特殊处理:归档之后不再产生新快照,曲线天然停在最后一次同步。
//
// 归档态**在这里自己读**,不收调用方传的:它决定「画到哪儿为止」,不该由客户端说了算。
//
// 从 `getAccountHistory` 里抽出来的,不是新逻辑 —— 抽的理由与 `account-holdings.ts` 一样:
// server fn 那层拿不到测试上下文,而这条分支的行为(末点停在哪)只有驱动真链路才验得到。
export const loadAccountHistory = (input: {
  accountId: string;
  since?: number;
  connectorId?: string;
}) =>
  Effect.gen(function* () {
    if (input.connectorId !== MANUAL_CONNECTOR_ID) {
      const snapshots = yield* Effect.flatMap(SnapshotStore, (s) =>
        s.listByAccount(input.accountId),
      );
      return { series: buildAccountValueHistory(snapshots, input.since) };
    }
    const account = yield* Effect.flatMap(AccountStore, (s) => s.getById(input.accountId));
    const archivedAt = account?.archivedAt ?? null;
    const now = archivedAt ?? Date.now();
    // **账本序列与实时末点一次装配**:两者本来就要对齐同一个 now,分两次跑还各建一套 store。
    const rows = yield* loadManualAccountSeries(input.accountId, now);
    const liveTotal =
      archivedAt != null ? null : yield* loadManualAccountLiveTotal(input.accountId);
    const series = buildAccountValueHistory(
      rows.map((r) => ({ takenAt: r.takenAt, totalUsd: r.totalUsd })),
      input.since,
    );
    // 末点接实时盯市(与抽屉头同源):有账本点才补,空账户不凭空造点(与快照路径空态一致)。
    if (liveTotal != null && series.length > 0) {
      const last = series[series.length - 1];
      if (last.t >= now) series[series.length - 1] = { t: last.t, total: liveTotal };
      else series.push({ t: now, total: liveTotal });
    }
    return { series };
  });
