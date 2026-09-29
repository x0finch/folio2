import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import { accountIdsInView, accountsInView } from "@/lib/core/accounts-in-view";
import { type HistoryRange, type PortfolioHistoryRaw, rangeSince } from "@/lib/core/history";
import { historyResolution } from "@/lib/core/history-range";
import { isManual } from "@/lib/core/manual";
import { loadManualHistoryRows } from "@/lib/server/manual/store";
import { scopedMembership } from "./scope";

export const PortfolioHistoryInput = z.object({
  portfolioId: z.string().optional(),
  range: z.enum(["7d", "30d", "1y", "all"]).default("30d"),
});

export const handleGetPortfolioHistory = Effect.fn("getPortfolioHistory")(function* (data: {
  portfolioId?: string;
  range?: HistoryRange;
}) {
  const range = data.range ?? "30d";
  const since = rangeSince(range, Date.now());
  const resolution = historyResolution({ range });
  const longWindow = resolution === "sampled";
  const db = yield* Database;
  const {
    selectedId,
    defaultId,
    accounts: allAccounts,
    memberships,
  } = yield* scopedMembership(data.portfolioId);
  const memberSet = accountIdsInView(
    allAccounts.map((a) => a.id),
    memberships,
    selectedId,
    defaultId,
  );
  const memberAccounts = allAccounts.filter((a) => memberSet.has(a.id));
  const snapAccountIds = memberAccounts.filter((a) => !isManual(a.connectorId)).map((a) => a.id);

  const tail = {
    archivedAt: memberAccounts.flatMap((a) =>
      a.archivedAt == null ? [] : [[a.id, a.archivedAt] as [string, number]],
    ),
    liveAccountIds: accountsInView(allAccounts, memberships, selectedId, defaultId).map(
      (a) => a.id,
    ),
  };

  // 手记账户不在快照表里:曲线由账本算(含窗口起点的 carry-in),不降采样 —— 长窗里它要进 SQL
  // 那条组合时间线(见下)。
  const manualRows = yield* loadManualHistoryRows(memberAccounts, Date.now(), { since });

  // 三档原料(FOL-91,见 `historyResolution`):≤ 7 天读原始快照;更长的窗口读日汇总 ——
  // 30 天原样发日收盘;1 年 / 全部在 SQL 里按桶挑保极值的时刻(每账户 ≤ 199 行,review #2)。重建与
  // min-max 降采样都在浏览器(`toPortfolioCurve`)。
  //
  // **长窗里手记账户一起进 SQL**(review R2-#5):候选时刻要在**整个组合**的时间线上挑,每个候选时刻
  // 带齐各账户(含手记)在那一刻的值。以前手记行按它自己的时刻另发(各自 min-max 过),浏览器在一个
  // 手记时刻上会把 synced 账户最多一桶(「全部」约 28 天)之前的值加进来,拼出一个从没存在过的组合值。
  // 于是长窗发回的就是 SQL 那一份(手记账户同样 ≤ 3 × 桶数 + 1 行),不再另拼手记行。
  if (longWindow) {
    const rows = yield* db.snapshots.listSampledTotals(
      snapAccountIds,
      since,
      undefined,
      manualRows,
    );
    return { ...tail, rows, sampled: true } satisfies PortfolioHistoryRaw;
  }
  const snapRows =
    resolution === "daily"
      ? yield* db.snapshots.listDailyTotals(snapAccountIds, since)
      : (yield* db.snapshots.listTotals(since)).filter((r) => snapAccountIds.includes(r.accountId));
  const manualIds = new Set(memberAccounts.filter((a) => isManual(a.connectorId)).map((a) => a.id));
  return {
    ...tail,
    rows: [...snapRows.filter((r) => !manualIds.has(r.accountId)), ...manualRows],
    sampled: false,
  } satisfies PortfolioHistoryRaw;
});
