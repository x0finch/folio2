import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import { accountIdsInView, accountsInView } from "@/lib/core/accounts-in-view";
import { type HistoryRange, type PortfolioHistoryRaw, rangeSince } from "@/lib/core/history";
import { historyResolution } from "@/lib/core/history-range";
import { isManual } from "@/lib/core/manual";
import { loadManualHistoryRows } from "@/lib/server/manual/store";
import { resolveScope } from "./scope";

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
  const { selectedId, defaultId } = yield* resolveScope(data.portfolioId);
  const [allAccounts, memberships] = yield* Effect.all(
    [db.accounts.list(), db.portfolios.listMemberships()],
    { concurrency: 2 },
  );
  const memberSet = accountIdsInView(
    allAccounts.map((a) => a.id),
    memberships,
    selectedId,
    defaultId,
  );
  const memberAccounts = allAccounts.filter((a) => memberSet.has(a.id));
  const snapAccountIds = memberAccounts.filter((a) => !isManual(a.connectorId)).map((a) => a.id);

  // 三档原料(FOL-91,见 `historyResolution`):≤ 7 天读原始快照;更长的窗口读日汇总 ——
  // 30 天原样发日收盘(浏览器照旧重建),1 年 / 全部再在服务端做组合级 min-max 降采样。
  const snapRows =
    resolution === "sampled"
      ? yield* db.snapshots.listTotalsMinMax(snapAccountIds, since)
      : resolution === "daily"
        ? yield* db.snapshots.listDailyTotals(snapAccountIds, since)
        : (yield* db.snapshots.listTotals(since)).filter((r) =>
            snapAccountIds.includes(r.accountId),
          );

  const manualIds = new Set(memberAccounts.filter((a) => isManual(a.connectorId)).map((a) => a.id));
  const manualRows = yield* loadManualHistoryRows(memberAccounts, Date.now(), {
    since,
    sampled: longWindow,
  });
  const archivedAt = memberAccounts.flatMap((a) =>
    a.archivedAt == null ? [] : [[a.id, a.archivedAt] as [string, number]],
  );
  const liveAccountIds = accountsInView(allAccounts, memberships, selectedId, defaultId).map(
    (a) => a.id,
  );
  return {
    rows: [...snapRows.filter((r) => !manualIds.has(r.accountId)), ...manualRows],
    archivedAt,
    liveAccountIds,
    sampled: longWindow,
  } satisfies PortfolioHistoryRaw;
});
